// dumate-export —— 在"登录了百度搭子（DuMate）账号的那台机器"上运行，只读导出：
//   · 登录 cookies（从客户端 auth.json 解密：AES-256-GCM，密钥在同目录 .cookie-key 明文文件）
//   · 账号信息（bceAccountId / displayName / loginType，取全部 profile，激活的排最前）
//   · 设备 ID（客户端启动时写入 Main.log 的 X-Dumate-Device-Id，取最新一次）
//   · 客户端版本（读 DuMate.exe 的 FileVersion，失败回退 dumate-install.json）
// 输出一个 JSON，供网关导入（凭据与设备身份天然配对）。
//
// 全程只读：不写、不删、不联网、不碰账号。与 Qoder 不同，cookies 的加密密钥是随客户端
// 数据目录落盘的明文文件（.cookie-key），不绑 DPAPI，因此**导出的凭据在别的机器可直接用**，
// 无需客户端参与；客户端一旦重新登录会刷新 cookies，届时需要重新导出。
package main

import (
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

// ================= Cookie 解密（与客户端 cookie.ts 的 nodeDecryptString 逐字对齐） =================
//
// 客户端加密（app.asar 内 cookie 模块）：AES-256-GCM，
// 密文 = base64( iv(12) || authTag(16) || ciphertext )，
// 密钥 = userData 目录下 .cookie-key 文件的 32 个原始字节。
// 加密实现优先走 N-API addon、失败熔断回落 Node crypto——两种实现的密文格式一致，
// 故这里只需实现这一种格式。

func aesGcmOpen(key, blob []byte) ([]byte, error) {
	const ivLen = 12
	const tagLen = 16
	if len(blob) < ivLen+tagLen {
		return nil, fmt.Errorf("密文长度异常: %d 字节", len(blob))
	}
	iv := blob[:ivLen]
	tag := blob[ivLen : ivLen+tagLen]
	ct := blob[ivLen+tagLen:]
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, iv, append(append([]byte{}, ct...), tag...), nil)
}

type cookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Expires  any    `json:"expirationDate,omitempty"`
	HTTPOnly bool   `json:"httpOnly,omitempty"`
	Secure   bool   `json:"secure,omitempty"`
}

// decryptCookies 解密 auth.json 里某个 profile 的 encryptedCookies，返回明文 cookie 数组
func decryptCookies(encrypted string, key []byte) ([]cookie, error) {
	blob, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encrypted))
	if err != nil {
		return nil, fmt.Errorf("base64 解码失败: %v", err)
	}
	plain, err := aesGcmOpen(key, blob)
	if err != nil {
		return nil, fmt.Errorf("AES-GCM 解密失败（.cookie-key 与 auth.json 不配套？）: %v", err)
	}
	var out []cookie
	if err := json.Unmarshal(plain, &out); err != nil {
		return nil, fmt.Errorf("明文不是 cookie 数组: %v", err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("cookie 数组为空")
	}
	return out, nil
}

// ================= auth.json（普通 JSON，无需 DPAPI） =================

type profile struct {
	ProfileID   string
	LoginType   string
	BceUserID   string
	BceAcctID   string
	DisplayName string
	TenantName  string
	// 企业版登录可能下发的字段（个人版为空）；按客户端 authStore 的形状带上，
	// 缺失不影响个人版导入
	EnterpriseAPIBase string
	VpcSvcURL         string

	EncCookies string
}

func readAuthStore(appDataDir string) (profiles []profile, activeID string, err error) {
	raw, err := os.ReadFile(filepath.Join(appDataDir, "auth.json"))
	if err != nil {
		return nil, "", fmt.Errorf("读 auth.json 失败: %v", err)
	}
	var store struct {
		AccountProfiles []json.RawMessage `json:"accountProfiles"`
		ActiveProfileID string            `json:"activeProfileId"`
		// 旧版顶层 cookies 槽（单账号时代的遗留，多账号 profile 结构上线后仍镜像写入）
		LegacyCookies string `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &store); err != nil {
		return nil, "", fmt.Errorf("解析 auth.json 失败: %v", err)
	}
	for _, r := range store.AccountProfiles {
		var full map[string]any
		if err := json.Unmarshal(r, &full); err != nil {
			continue
		}
		enc, _ := full["encryptedCookies"].(string)
		delete(full, "encryptedCookies")
		var p profile
		p.ProfileID, _ = full["profileId"].(string)
		p.LoginType, _ = full["loginType"].(string)
		p.BceUserID, _ = full["bceUserId"].(string)
		p.BceAcctID, _ = full["bceAccountId"].(string)
		p.DisplayName, _ = full["displayName"].(string)
		p.TenantName, _ = full["tenantName"].(string)
		if p.TenantName == "" {
			if v, ok := full["tenantId"].(string); ok {
				p.TenantName = v
			}
		}
		p.EnterpriseAPIBase, _ = full["enterpriseApiBaseUrl"].(string)
		p.VpcSvcURL, _ = full["vpcSvcUrl"].(string)
		p.EncCookies = enc
		profiles = append(profiles, p)
	}
	// 没有任何 profile 时退回旧版顶层槽（单账号旧格式：cookies 在顶层）
	if len(profiles) == 0 && store.LegacyCookies != "" {
		profiles = append(profiles, profile{LoginType: "bce", EncCookies: store.LegacyCookies})
	}
	return profiles, store.ActiveProfileID, nil
}

func readCookieKey(appDataDir string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(appDataDir, ".cookie-key"))
	if err != nil {
		return nil, fmt.Errorf("读 .cookie-key 失败（客户端装过但从未登录？）: %v", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf(".cookie-key 长度异常: %d（应为 32 字节）", len(raw))
	}
	return raw, nil
}

// ================= 设备 ID（从 Main.log 抓，取最新一次） =================

// readDeviceID 扫 desktop-main 日志（Main.log 及轮转 Main.log.N，新文件优先），
// 取最新一条 X-Dumate-Device-Id:[...]。客户端每次启动都会以 DEBUG 打印内部代理请求头，
// 设备 ID 稳定出现在其中；未启动过客户端时抓不到，只能如实报错。
func readDeviceID(logDir string) (string, error) {
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return "", fmt.Errorf("读日志目录失败: %v", err)
	}
	var logs []os.DirEntry
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			continue
		}
		if name == "Main.log" || (strings.HasPrefix(name, "Main.log.") && len(name) > len("Main.log.") && name[len(name)-1] >= '0' && name[len(name)-1] <= '9') {
			logs = append(logs, e)
		}
	}
	if len(logs) == 0 {
		return "", fmt.Errorf("desktop-main 目录下没有 Main.log（客户端从未启动过）")
	}
	// Main.log 恒为最新；轮转文件之间比修改时间
	sort.Slice(logs, func(i, j int) bool {
		if (logs[i].Name() == "Main.log") != (logs[j].Name() == "Main.log") {
			return logs[i].Name() == "Main.log"
		}
		ti, _ := logs[i].Info()
		tj, _ := logs[j].Info()
		return ti.ModTime().After(tj.ModTime())
	})
	for _, e := range logs {
		data, err := os.ReadFile(filepath.Join(logDir, e.Name()))
		if err != nil {
			continue
		}
		text := string(data)
		idx := strings.LastIndex(text, "X-Dumate-Device-Id:[")
		if idx < 0 {
			continue
		}
		rest := text[idx+len("X-Dumate-Device-Id:["):]
		end := strings.Index(rest, "]")
		if end <= 0 {
			continue
		}
		return strings.TrimSpace(rest[:end]), nil
	}
	return "", fmt.Errorf("日志里没有 X-Dumate-Device-Id（客户端从未启动过？）")
}

// ================= 客户端版本（DuMate.exe 的 FileVersion，形如 1.0.92.512） =================

var (
	versionDLL              = syscall.NewLazyDLL("version.dll")
	procGetFileVersionInfoW = versionDLL.NewProc("GetFileVersionInfoW")
	procGetVerInfoSizeW     = versionDLL.NewProc("GetFileVersionInfoSizeW")
	procVerQueryValueW      = versionDLL.NewProc("VerQueryValueW")
)

func utf16Ptr(s string) uintptr {
	p, _ := syscall.UTF16PtrFromString(s)
	return uintptr(unsafe.Pointer(p))
}

// exeFileVersion 读 Windows PE 版本资源的 FileVersion 字符串（客户端 UA 用的就是这个四段值）
func exeFileVersion(exePath string) string {
	size, _, _ := procGetVerInfoSizeW.Call(utf16Ptr(exePath), 0, 0, 0)
	if size == 0 {
		return ""
	}
	buf := make([]byte, size)
	if r, _, _ := procGetFileVersionInfoW.Call(utf16Ptr(exePath), 0, size, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
		return ""
	}
	var pval uintptr
	var vlen uint32
	for _, codepage := range []string{"\\StringFileInfo\\080404b0\\FileVersion", "\\StringFileInfo\\040904b0\\FileVersion"} {
		r, _, _ := procVerQueryValueW.Call(uintptr(unsafe.Pointer(&buf[0])), utf16Ptr(codepage), uintptr(unsafe.Pointer(&pval)), uintptr(unsafe.Pointer(&vlen)))
		if r != 0 && vlen > 0 {
			ws := unsafe.Slice((*uint16)(unsafe.Pointer(pval)), vlen)
			return strings.TrimRight(syscall.UTF16ToString(ws), "\x00")
		}
	}
	return ""
}

func readClientVersion(appDataDir string) (version string, installDir string) {
	// dumate-install.json：{product, version, install_dir, ...}——三段版本，兜底
	raw, err := os.ReadFile(filepath.Join(appDataDir, "dumate-install.json"))
	if err == nil {
		var j struct {
			Version    string `json:"version"`
			InstallDir string `json:"install_dir"`
		}
		if json.Unmarshal(raw, &j) == nil {
			version = j.Version
			installDir = j.InstallDir
		}
	}
	// exe 的 FileVersion 是四段（客户端 UA DumateApp/x.y.z.w 用的就是它），优先
	if installDir != "" {
		if v := exeFileVersion(filepath.Join(installDir, "DuMate.exe")); v != "" {
			version = v
		}
	}
	return version, installDir
}

// ================= 主流程 =================

type result struct {
	Channel       string       `json:"channel"`
	Account       *accountInfo `json:"account"`
	Cookies       []cookie     `json:"cookies"`
	DeviceID      string       `json:"deviceId"`
	ClientVersion string       `json:"clientVersion"`
	InstallDir    string       `json:"installDir,omitempty"`
	Notes         []string     `json:"notes,omitempty"`
}

type accountInfo struct {
	UID               string `json:"uid"`
	Name              string `json:"name"`
	LoginType         string `json:"loginType"`
	TenantName        string `json:"tenantName,omitempty"`
	EnterpriseAPIBase string `json:"enterpriseApiBaseUrl,omitempty"`
	VpcSvcURL         string `json:"vpcSvcUrl,omitempty"`
}

func main() {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		fmt.Println("读不到 APPDATA 环境变量，请在 Windows 用户会话下运行。")
		os.Exit(1)
	}
	appDataDir := filepath.Join(appData, "qianfan-desktop-app")

	hostname, _ := os.Hostname()
	osInfo := readOS()

	results := []result{}
	commonNotes := []string{}

	key, err := readCookieKey(appDataDir)
	if err != nil {
		fmt.Println("×", err)
		fmt.Println("未发现可导出的百度搭子登录态（qianfan-desktop-app 数据目录不完整）。")
		os.Exit(1)
	}

	profiles, activeID, err := readAuthStore(appDataDir)
	if err != nil {
		fmt.Println("×", err)
		os.Exit(1)
	}

	// 导出全部 profile 的 cookies（多账号一次带走）；激活的排最前
	sort.SliceStable(profiles, func(i, j int) bool {
		return profiles[i].ProfileID == activeID && profiles[j].ProfileID != activeID
	})
	for _, p := range profiles {
		r := result{Channel: "dumate"}
		uid := p.BceAcctID
		if uid == "" {
			uid = p.BceUserID
		}
		if uid == "" {
			commonNotes = append(commonNotes, "profile "+head(p.ProfileID, 8)+"… 缺账号 ID，已跳过")
			continue
		}
		r.Account = &accountInfo{
			UID:               uid,
			Name:              p.DisplayName,
			LoginType:         p.LoginType,
			TenantName:        p.TenantName,
			EnterpriseAPIBase: p.EnterpriseAPIBase,
			VpcSvcURL:         p.VpcSvcURL,
		}
		cs, err := decryptCookies(p.EncCookies, key)
		if err != nil {
			r.Notes = append(r.Notes, "cookies 解密失败: "+err.Error())
			results = append(results, r)
			continue
		}
		r.Cookies = cs
		results = append(results, r)
	}

	// 设备 ID 与版本：所有结果共用（同一台客户端机器）
	if len(results) > 0 {
		logDir := filepath.Join(appDataDir, "log", "desktop-main")
		dev, err := readDeviceID(logDir)
		if err != nil {
			commonNotes = append(commonNotes, "设备 ID 读取失败: "+err.Error())
		}
		ver, installDir := readClientVersion(appDataDir)
		if ver == "" {
			commonNotes = append(commonNotes, "客户端版本读取失败（exe 版本与 dumate-install.json 都没有）")
		}
		for i := range results {
			results[i].DeviceID = dev
			results[i].ClientVersion = ver
			results[i].InstallDir = installDir
			results[i].Notes = append(results[i].Notes, commonNotes...)
		}
	}

	out := map[string]any{
		"exportedAt": time.Now().Format(time.RFC3339),
		"tool":       "dumate-export v1",
		"machine": map[string]string{
			"hostname": hostname,
			"os":       osInfo,
			"arch":     runtime.GOARCH,
		},
		"results": results,
	}

	data, _ := json.MarshalIndent(out, "", "  ")
	name := fmt.Sprintf("dumate-export-%s.json", time.Now().Format("20060102-150405"))
	if err := os.WriteFile(name, data, 0644); err != nil {
		fmt.Println("写文件失败:", err)
		os.Exit(1)
	}

	fmt.Println("=== dumate-export ===")
	fmt.Println("机器:", hostname, "|", osInfo)
	fmt.Println("输出:", name)
	for _, r := range results {
		fmt.Printf("\n[%s]\n", r.Channel)
		if r.Account != nil {
			fmt.Printf("  账号: uid=%s name=%q loginType=%s\n", r.Account.UID, r.Account.Name, r.Account.LoginType)
		}
		fmt.Printf("  cookies: %d 条（已解密，网关直接使用）\n", len(r.Cookies))
		fmt.Printf("  设备 ID: %s\n", head(r.DeviceID, 24))
		fmt.Printf("  客户端版本: %s\n", r.ClientVersion)
		for _, n := range r.Notes {
			fmt.Println("  注意:", n)
		}
	}
	if len(results) == 0 {
		fmt.Println("\n未发现已登录的百度搭子账号（auth.json 里没有 profile）。")
	} else {
		fmt.Println("\n提示: 导出的 cookies 在客户端重新登录后会失效，届时请重新导出并重新导入网关。")
	}
}

func head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func readOS() string {
	if out, err := exec.Command("cmd", "/c", "ver").Output(); err == nil {
		return strings.TrimSpace(string(out))
	}
	return runtime.GOOS
}
