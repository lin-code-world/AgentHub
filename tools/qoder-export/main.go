// qoder-export —— 在"登录了 Qoder 账号的那台机器"上运行，只读导出：
//   · 账号凭据（从客户端登录态解密：auth.v1.dat + Local State）
//   · 该机器的设备身份三件套（umid-cache.json，缺则现场跑组件）
//   · 机器编号 / 客户端版本 / 主机名等
// 输出一个 JSON，供网关导入（账号与身份天然配对）。
//
// 全程只读：不写、不删、不联网、不碰账号。跨机无法直接拷 auth.v1.dat（DPAPI 绑定机器），
// 故必须在目标机器上运行本工具。
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// ================= DPAPI（CryptUnprotectData, CurrentUser） =================

type dataBlob struct {
	cbData uint32
	pbData *byte
}

var (
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = kernel32.NewProc("LocalFree")
)

func toBlob(data []byte) dataBlob {
	var b dataBlob
	if len(data) > 0 {
		b.cbData = uint32(len(data))
		b.pbData = &data[0]
	}
	return b
}

func dpapiUnprotect(data []byte) ([]byte, error) {
	in := toBlob(data)
	var out dataBlob
	r, _, _ := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("DPAPI 解密失败（需与 Qoder 客户端在同一台机器、同一 Windows 用户下运行）")
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	buf := unsafe.Slice(out.pbData, out.cbData)
	res := make([]byte, len(buf))
	copy(res, buf)
	return res, nil
}

// ================= auth.v1.dat（v10 信封：AES-256-GCM） =================

func aesGcmOpen(key, blob []byte) ([]byte, error) {
	if len(blob) < 3+12+16 || string(blob[:3]) != "v10" {
		return nil, fmt.Errorf("auth 信封格式异常（非 v10）")
	}
	nonce := blob[3:15]
	ct := blob[15 : len(blob)-16]
	tag := blob[len(blob)-16:]
	sealed := append(append([]byte{}, ct...), tag...)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, sealed, nil)
}

func readAesKey(appDataDir string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(appDataDir, "Local State"))
	if err != nil {
		return nil, fmt.Errorf("读 Local State 失败: %v", err)
	}
	var ls struct {
		OsCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &ls); err != nil {
		return nil, fmt.Errorf("解析 Local State 失败: %v", err)
	}
	if ls.OsCrypt.EncryptedKey == "" {
		return nil, fmt.Errorf("Local State 缺少 os_crypt.encrypted_key")
	}
	key, err := base64.StdEncoding.DecodeString(ls.OsCrypt.EncryptedKey)
	if err != nil {
		return nil, fmt.Errorf("解密密钥 base64 失败: %v", err)
	}
	if len(key) < 5 || string(key[:5]) != "DPAPI" {
		return nil, fmt.Errorf("os_crypt 前缀异常")
	}
	plain, err := dpapiUnprotect(key[5:])
	if err != nil {
		return nil, err
	}
	if len(plain) != 32 {
		return nil, fmt.Errorf("DPAPI 密钥长度异常: %d", len(plain))
	}
	return plain, nil
}

type account struct {
	UID                   string `json:"uid"`
	Name                  string `json:"name"`
	Email                 string `json:"email"`
	Token                 string `json:"token"`
	RefreshToken          string `json:"refreshToken"`
	ExpiresAt             any    `json:"expiresAt"`
	RefreshTokenExpiresAt any    `json:"refreshTokenExpiresAt"`
}

func readAccount(appDataDir string) (*account, error) {
	key, err := readAesKey(appDataDir)
	if err != nil {
		return nil, err
	}
	blob, err := os.ReadFile(filepath.Join(appDataDir, "auth.v1.dat"))
	if err != nil {
		return nil, fmt.Errorf("读 auth.v1.dat 失败: %v", err)
	}
	plain, err := aesGcmOpen(key, blob)
	if err != nil {
		return nil, fmt.Errorf("解密 auth.v1.dat 失败: %v", err)
	}
	var store struct {
		Token                  string         `json:"token"`
		RefreshToken           string         `json:"refreshToken"`
		ExpiresAt              any            `json:"expiresAt"`
		RefreshTokenExpiresAt  any            `json:"refreshTokenExpiresAt"`
		User                   map[string]any `json:"user"`
	}
	if err := json.Unmarshal(plain, &store); err != nil {
		return nil, fmt.Errorf("解析 auth.v1.dat 失败: %v", err)
	}
	if store.Token == "" {
		return nil, fmt.Errorf("auth.v1.dat 里没有 token")
	}
	a := &account{
		Token:                 store.Token,
		RefreshToken:          store.RefreshToken,
		ExpiresAt:             store.ExpiresAt,
		RefreshTokenExpiresAt: store.RefreshTokenExpiresAt,
	}
	if store.User != nil {
		a.UID = str(store.User["id"])
		a.Name = str(store.User["name"])
		a.Email = str(store.User["email"])
	}
	return a, nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// ================= 设备身份 =================

type riskIdentity struct {
	MachineToken string `json:"machineToken"`
	MachineType  string `json:"machineType"`
	MachineCode  string `json:"machineCode"`
	Source       string `json:"source"`
}

func readUmidCache(homeDir string) (*riskIdentity, error) {
	raw, err := os.ReadFile(filepath.Join(homeDir, "umid-cache.json"))
	if err != nil {
		return nil, err
	}
	var c struct {
		Info struct {
			MachineToken string `json:"machineToken"`
			MachineType  string `json:"machineType"`
			MachineCode  string `json:"machineCode"`
		} `json:"info"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if c.Info.MachineToken == "" {
		return nil, fmt.Errorf("umid-cache.json 里没有 machineToken")
	}
	return &riskIdentity{c.Info.MachineToken, c.Info.MachineType, c.Info.MachineCode, "cache"}, nil
}

func findComponent(homeDir, exeLabel string) string {
	// qodercli 解压形态：~/<homeDir>/.bin/umid-*/runtime-info.exe
	binDir := filepath.Join(homeDir, ".bin")
	if entries, err := os.ReadDir(binDir); err == nil {
		var dirs []string
		for _, e := range entries {
			if e.IsDir() && strings.HasPrefix(e.Name(), "umid-") {
				dirs = append(dirs, e.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
		for _, d := range dirs {
			c := filepath.Join(binDir, d, "runtime-info.exe")
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}
	// 客户端安装目录
	loc := os.Getenv("LOCALAPPDATA")
	for _, c := range []string{
		filepath.Join(loc, "Programs", exeLabel, "resources", "umid", "runtime-info.exe"),
		filepath.Join(loc, exeLabel, "resources", "umid", "runtime-info.exe"),
	} {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func runComponent(exe, uid string) (*riskIdentity, error) {
	cmd := exec.Command(exe, "--account-stdin")
	cmd.Stdin = strings.NewReader(fmt.Sprintf(`{"account":%q}`, uid))
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	line := strings.SplitN(strings.TrimSpace(out.String()), "\n", 2)[0]
	var j struct {
		MachineToken string `json:"machineToken"`
		MachineType  string `json:"machineType"`
		MachineCode  string `json:"machineCode"`
	}
	if err := json.Unmarshal([]byte(line), &j); err != nil {
		return nil, fmt.Errorf("组件输出不是 JSON: %v", err)
	}
	if j.MachineToken == "" {
		return nil, fmt.Errorf("组件未返回 machineToken")
	}
	return &riskIdentity{j.MachineToken, j.MachineType, j.MachineCode, "component"}, nil
}

// ================= 主流程 =================

type variant struct {
	Product  string
	Channel  string
	AppDir   string
	HomeDir  string
	ExeLabel string
}

var variants = []variant{
	{"qoder", "qoder", "com.qodercn.app.stable", ".qoder-cn", "Qoder CN"},
	{"qoder_intl", "qoder_intl", "com.qoder.app.stable", ".qoder", "Qoder"},
}

// catalogBlob 是客户端模型目录缓存（加密的 QMC 信封，原样带走；网关侧用账号 ID 纯算法解密）
type catalogBlob struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

type result struct {
	Product       string         `json:"product"`
	Channel       string         `json:"channel"`
	AppDataDir    string         `json:"appDataDir"`
	Account       *account       `json:"account"`
	Device        *riskIdentity  `json:"device"`
	Catalog       *catalogBlob   `json:"catalog,omitempty"`
	MachineId     string         `json:"machineId"`
	MachineIdAlt  string         `json:"machineIdAlt"`
	ClientVersion string         `json:"clientVersion"`
	Notes         []string       `json:"notes,omitempty"`
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// readCatalog 读取客户端的模型目录缓存（catalog-v7 优先，v6 兜底），原样返回加密文本
func readCatalog(homeDir, uid string) *catalogBlob {
	if uid == "" {
		return nil
	}
	dir := filepath.Join(homeDir, ".models", uid)
	for _, name := range []string{"catalog-v7", "catalog-v6"} {
		p := filepath.Join(dir, name)
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			return &catalogBlob{Name: name, Data: strings.TrimSpace(string(b))}
		}
	}
	return nil
}

func readTrim(p string) string {
	if p == "" {
		return ""
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func main() {
	appData := os.Getenv("APPDATA")
	home := os.Getenv("USERPROFILE")
	if home == "" {
		home, _ = os.UserHomeDir()
	}

	hostname, _ := os.Hostname()
	osInfo := readOS()

	results := []result{}
	for _, v := range variants {
		appDataDir := filepath.Join(appData, v.AppDir)
		homeDir := filepath.Join(home, v.HomeDir)
		authFile := filepath.Join(appDataDir, "auth.v1.dat")
		if _, err := os.Stat(authFile); err != nil {
			continue // 该产品未在本机登录
		}
		notes := []string{}
		r := result{Product: v.Product, Channel: v.Channel, AppDataDir: appDataDir}

		acc, err := readAccount(appDataDir)
		if err != nil {
			notes = append(notes, "账号凭据读取失败: "+err.Error())
		} else {
			r.Account = acc
		}

		// 设备身份：优先读缓存，缺则现场跑组件
		dev, err := readUmidCache(homeDir)
		if err != nil {
			if comp := findComponent(homeDir, v.ExeLabel); comp != "" {
				uid := ""
				if acc != nil {
					uid = acc.UID
				}
				if d2, e2 := runComponent(comp, uid); e2 == nil {
					dev = d2
				} else {
					notes = append(notes, "组件生成身份失败: "+e2.Error())
				}
			} else {
				notes = append(notes, "未找到设备身份：既无 umid-cache.json，也未找到 runtime-info 组件")
			}
		}
		r.Device = dev

		// 模型目录（catalog-v7/v6，加密的 QMC 信封）原样带走：网关侧用账号 ID 纯算法解密，
		// 目标机没装客户端也能读出模型列表
		if acc != nil {
			if cat := readCatalog(homeDir, acc.UID); cat != nil {
				r.Catalog = cat
			} else {
				notes = append(notes, "未找到模型目录缓存（catalog-v7/v6），导入后模型列表会为空")
			}
		}

		r.MachineId = readTrim(filepath.Join(homeDir, ".auth", "machine_id"))
		r.MachineIdAlt = readTrim(filepath.Join(appDataDir, "auth.machine-id"))
		// 客户端版本
		if st := readTrim(filepath.Join(homeDir, ".qoder-app-status.json")); st != "" {
			var s struct {
				Version string `json:"version"`
			}
			if json.Unmarshal([]byte(st), &s) == nil {
				r.ClientVersion = s.Version
			}
		}
		r.Notes = notes
		results = append(results, r)
	}

	out := map[string]any{
		"exportedAt": time.Now().Format(time.RFC3339),
		"tool":       "qoder-export v1",
		"machine": map[string]string{
			"hostname": hostname,
			"os":       osInfo,
			"arch":     runtime.GOARCH,
		},
		"results": results,
	}

	data, _ := json.MarshalIndent(out, "", "  ")
	name := fmt.Sprintf("qoder-export-%s.json", time.Now().Format("20060102-150405"))
	if err := os.WriteFile(name, data, 0644); err != nil {
		fmt.Println("写文件失败:", err)
		os.Exit(1)
	}

	// 控制台摘要
	fmt.Println("=== qoder-export ===")
	fmt.Println("机器:", hostname, "|", osInfo)
	fmt.Println("输出:", name)
	for _, r := range results {
		fmt.Printf("\n[%s]\n", r.Channel)
		if r.Account != nil {
			fmt.Printf("  账号: uid=%s name=%q\n", r.Account.UID, r.Account.Name)
			fmt.Printf("  token: %s… (len=%d)\n", head(r.Account.Token, 16), len(r.Account.Token))
			fmt.Printf("  refreshToken: %s… (len=%d)\n", head(r.Account.RefreshToken, 12), len(r.Account.RefreshToken))
		}
		if r.Device != nil {
			fmt.Printf("  设备身份: token=%s… type=%s code=%s (来源=%s)\n",
				head(r.Device.MachineToken, 16), r.Device.MachineType, r.Device.MachineCode, r.Device.Source)
		}
		fmt.Printf("  机器编号: %s | 客户端版本: %s\n", r.MachineId, r.ClientVersion)
		if r.Catalog != nil {
			fmt.Printf("  模型目录: %s（%d 字符，加密原样带走）\n", r.Catalog.Name, len(r.Catalog.Data))
		}
		for _, n := range r.Notes {
			fmt.Println("  注意:", n)
		}
	}
	if len(results) == 0 {
		fmt.Println("\n未发现已登录的 Qoder 账号（未找到 auth.v1.dat）。")
	}
}

func head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func readOS() string {
	// 尽量取与客户端一致的形态；读不到就不影响导出
	if out, err := exec.Command("cmd", "/c", "ver").Output(); err == nil {
		return strings.TrimSpace(string(out))
	}
	return runtime.GOOS
}
