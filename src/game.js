// Figures out which game you were in when a clip was saved (foreground window's process).
const { execFile } = require('child_process');

const PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class CdFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h = [CdFg]::GetForegroundWindow(); $procId = 0
[void][CdFg]::GetWindowThreadProcessId($h, [ref]$procId)
$sb = New-Object System.Text.StringBuilder 512; [void][CdFg]::GetWindowText($h, $sb, 512)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$exePath = $null; try { $exePath = $p.Path } catch {}
$vi = $null; if ($exePath) { try { $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath) } catch {} }
[pscustomobject]@{ exe = $p.ProcessName; title = $sb.ToString(); path = $exePath; product = $vi.ProductName; desc = $vi.FileDescription } | ConvertTo-Json -Compress
`;
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');

function foregroundInfo() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

const NOT_GAMES = new Set([
  'explorer', 'obs64', 'obs32', 'obs', 'clipdeck', 'electron', 'searchhost', 'shellexperiencehost',
  'startmenuexperiencehost', 'applicationframehost', 'lockapp', 'taskmgr', 'idle', 'textinputhost',
]);
const GENERIC_PRODUCT = /(microsoft|windows|unity|unreal|bootstrap|epic games|launcher|java\(tm\)|openjdk|electron|chromium|^game$)/i;

function cleanName(s) {
  return (s || '')
    .replace(/[™®©]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/-Win64-Shipping|-Win32-Shipping|_x64|\.exe$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
}

/** Returns { exe, name } where name is the folder/game name. exeMap: user overrides exe -> name. */
function resolveGame(info, exeMap = {}) {
  if (!info || !info.exe) return { exe: null, name: 'Unsorted' };
  const exe = String(info.exe).toLowerCase();
  if (exeMap[exe]) return { exe, name: exeMap[exe] };
  if (NOT_GAMES.has(exe)) return { exe: null, name: 'Desktop' };
  let name = '';
  if (exe === 'javaw' || exe === 'java') {
    name = cleanName((info.title || '').replace(/\s*[\d.]+.*$/, '')) || 'Java Game';
  } else {
    for (const cand of [info.product, info.desc]) {
      const c = cleanName(cand);
      if (c && !GENERIC_PRODUCT.test(c)) {
        name = c;
        break;
      }
    }
    if (!name) name = cleanName(info.title) || cleanName(info.exe);
  }
  return { exe, name: name || 'Unsorted' };
}

module.exports = { foregroundInfo, resolveGame, cleanName };
