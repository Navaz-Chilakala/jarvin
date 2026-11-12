# A bounded native Windows input worker. Server mode accepts one JSON request per line.
param([switch]$Server)
# This worker is launched without a shell; no model-provided text becomes PowerShell code.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JarvinWin32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static bool MouseClick() {
    INPUT[] events = new INPUT[2];
    events[0].type = 0; events[0].data.mi.dwFlags = 0x0002;
    events[1].type = 0; events[1].data.mi.dwFlags = 0x0004;
    return SendInput(2, events, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
  public static bool MouseScroll(int delta) {
    INPUT[] events = new INPUT[1];
    events[0].type = 0; events[0].data.mi.dwFlags = 0x0800;
    events[0].data.mi.mouseData = unchecked((uint)delta);
    return SendInput(1, events, Marshal.SizeOf(typeof(INPUT))) == 1;
  }
  private static INPUT Key(ushort vk, bool up) {
    INPUT input = new INPUT(); input.type = 1; input.data.ki.wVk = vk;
    input.data.ki.dwFlags = up ? 0x0002u : 0u;
    return input;
  }
  public static bool Traverse(bool window, bool previous) {
    ushort modifier = window ? (ushort)0x12 : (ushort)0x11;
    INPUT[] events = previous ? new INPUT[6] : new INPUT[4];
    int index = 0;
    events[index++] = Key(modifier, false);
    if (previous) events[index++] = Key(0x10, false);
    events[index++] = Key(0x09, false);
    events[index++] = Key(0x09, true);
    if (previous) events[index++] = Key(0x10, true);
    events[index++] = Key(modifier, true);
    return SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(INPUT))) == events.Length;
  }
}
'@
try {
  if (-not [JarvinWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) {
    if ([JarvinWin32]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) -eq [IntPtr]::Zero) { [void][JarvinWin32]::SetProcessDPIAware() }
  }
} catch [System.EntryPointNotFoundException] { [void][JarvinWin32]::SetProcessDPIAware() }

function WindowIdentity([IntPtr]$h) {
  if (-not [JarvinWin32]::IsWindow($h) -or -not [JarvinWin32]::IsWindowVisible($h)) { throw 'The pinned window is no longer visible; it may be minimized or hidden. Call launch_app with the app name to bring it back, then list windows again and take a fresh look before acting.' }
  [uint32]$pidValue = 0
  [void][JarvinWin32]::GetWindowThreadProcessId($h, [ref]$pidValue)
  if ($pidValue -eq 0) { throw 'Could not identify the window process.' }
  $p = [Diagnostics.Process]::GetProcessById([int]$pidValue)
  $title = [Text.StringBuilder]::new(512)
  [void][JarvinWin32]::GetWindowText($h, $title, $title.Capacity)
  return @{ handle = $h.ToInt64().ToString(); pid = [int]$pidValue; started = $p.StartTime.ToUniversalTime().Ticks.ToString(); title = $title.ToString(); app = $p.ProcessName }
}

function CheckedWindow($r) {
  $h = [IntPtr]::new([long]::Parse([string]$r.window.handle))
  $current = WindowIdentity $h
  if ($current.pid -ne [int]$r.window.pid -or $current.started -ne [string]$r.window.started) { throw 'Window identity changed. List windows and inspect again.' }
  foreach ($name in @($r.excluded_apps)) {
    if ($name -and $current.app -ieq ([string]$name).Replace('.exe','')) { throw 'This app is excluded in Privacy settings. No desktop action was sent.' }
  }
  foreach ($part in @($r.excluded_titles)) {
    if ($part -and $current.title.IndexOf([string]$part, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'This window is excluded in Privacy settings. No desktop action was sent.' }
  }
  return $h
}

function WalkControls([IntPtr]$h) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($null -eq $root) { throw 'Windows did not provide an accessibility tree for this window.' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $queue.Enqueue($root)
  $records = [Collections.Generic.List[object]]::new()
  $issues = [Collections.Generic.List[string]]::new()
  $seen = 0; $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ($queue.Count -gt 0 -and $seen -lt 1200 -and [DateTime]::UtcNow -lt $deadline) {
    $el = $queue.Dequeue(); $seen++
    try {
      $current = $el.Current
      $rid = ($el.GetRuntimeId() -join ':')
      $rect = $current.BoundingRectangle
      if ($rid -and -not $current.IsOffscreen -and -not $rect.IsEmpty) {
        $isPassword = [bool]$current.IsPassword
        $valuePattern = $null; $invokePattern = $null
        $canValue = $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)
        $canInvoke = $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)
        $label = if ($isPassword) { '[protected field]' } else { [string]$current.Name }
        if ($label.Length -gt 250) { $label = $label.Substring(0, 250) }
        $records.Add(@{ runtime = $rid; name = $label; role = $current.ControlType.ProgrammaticName.Replace('ControlType.',''); enabled = [bool]$current.IsEnabled; password = $isPassword; value = [bool]$canValue; invoke = [bool]$canInvoke; x = [Math]::Round($rect.X); y = [Math]::Round($rect.Y); width = [Math]::Round($rect.Width); height = [Math]::Round($rect.Height) })
      }
    } catch { if ($issues.Count -lt 3) { $issues.Add([string]$_.Exception.Message) } }
    try {
      $child = $walker.GetFirstChild($el); $siblings = 0
      while ($null -ne $child -and $siblings -lt 500 -and $queue.Count -lt 1200) {
        $queue.Enqueue($child); $siblings++; $child = $walker.GetNextSibling($child)
      }
    } catch { }
  }
  return @{ records = @($records.ToArray()); truncated = ($queue.Count -gt 0); visited = $seen; issues = @($issues.ToArray()) }
}

function FindControl([IntPtr]$h, [string]$runtime) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($null -eq $root) { throw 'Window is unavailable.' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new(); $queue.Enqueue($root)
  $seen = 0; $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ($queue.Count -gt 0 -and $seen -lt 1200 -and [DateTime]::UtcNow -lt $deadline) {
    $el = $queue.Dequeue(); $seen++
    try { if (($el.GetRuntimeId() -join ':') -eq $runtime) { return $el } } catch { }
    try { $child = $walker.GetFirstChild($el); $siblings = 0; while ($null -ne $child -and $siblings -lt 500 -and $queue.Count -lt 1200) { $queue.Enqueue($child); $siblings++; $child = $walker.GetNextSibling($child) } } catch { }
  }
  throw 'Control changed or disappeared. Inspect the window again.'
}

function Invoke-DesktopRequest($request) {
  if ($request.op -eq 'ping') { return @{ ready = $true } }
  if ($request.op -eq 'privacy_scan') {
    $handles = [Collections.Generic.List[IntPtr]]::new()
    $callback = [JarvinWin32+EnumProc]{ param($h, $l) if ([JarvinWin32]::IsWindowVisible($h) -and -not [JarvinWin32]::IsIconic($h)) { $handles.Add($h) }; return $true }
    [void][JarvinWin32]::EnumWindows($callback, [IntPtr]::Zero)
    $windows = [Collections.Generic.List[object]]::new()
    $uncertain = $false
    foreach ($h in $handles) {
      if ($windows.Count -ge 512) { break }
      $name = [Text.StringBuilder]::new(512)
      [void][JarvinWin32]::GetWindowText($h, $name, $name.Capacity)
      [uint32]$pidValue = 0
      [void][JarvinWin32]::GetWindowThreadProcessId($h, [ref]$pidValue)
      $appName = ''
      try { if ($pidValue -gt 0) { $appName = [Diagnostics.Process]::GetProcessById([int]$pidValue).ProcessName } } catch { }
      if (-not $appName -and $name.Length -gt 0) { $uncertain = $true }
      if ($appName -or $name.Length -gt 0) { $windows.Add(@{ app = $appName; title = $name.ToString() }) }
    }
    $result = @{ windows = @($windows.ToArray()); truncated = ($handles.Count -gt 512); uncertain = $uncertain }
  } elseif ($request.op -eq 'list') {
    $handles = [Collections.Generic.List[IntPtr]]::new()
    $callback = [JarvinWin32+EnumProc]{ param($h, $l) if ([JarvinWin32]::IsWindowVisible($h)) { $handles.Add($h) }; return $true }
    [void][JarvinWin32]::EnumWindows($callback, [IntPtr]::Zero)
    $windows = [Collections.Generic.List[object]]::new()
    foreach ($h in $handles) {
      if ($windows.Count -ge 80) { break }
      try { $item = WindowIdentity $h; if ($item.title) { $windows.Add($item) } } catch { }
    }
    $result = @{ windows = @($windows.ToArray()) }
  } elseif ($request.op -eq 'foreground') {
    # After Jarvin hides, Windows may briefly retain its hidden window as the
    # foreground window. Wait for focus to settle; never guess a replacement.
    $h = [IntPtr]::Zero
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      $h = [JarvinWin32]::GetForegroundWindow()
      if ($h -ne [IntPtr]::Zero -and [JarvinWin32]::IsWindow($h) -and [JarvinWin32]::IsWindowVisible($h) -and -not [JarvinWin32]::IsIconic($h)) { break }
      $h = [IntPtr]::Zero
      Start-Sleep -Milliseconds 150
    }
    if ($h -eq [IntPtr]::Zero) { throw 'No visible foreground window is ready. List windows, focus the intended window, and take a fresh look before acting.' }
    $result = @{ window = (WindowIdentity $h) }
  } elseif ($request.op -eq 'foreground_check') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. Look at the screen again.' }
    $result = @{ ok = $true }
  } elseif ($request.op -eq 'window_at_point') {
    $pt = [JarvinWin32+POINT]::new(); $pt.X = [int]$request.x; $pt.Y = [int]$request.y
    $h = [JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2)
    if ($h -eq [IntPtr]::Zero) { throw 'No visible window was found at the target. No click was sent.' }
    $result = @{ window = (WindowIdentity $h) }
  } elseif ($request.op -eq 'traverse') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. No traversal key was sent.' }
    if ($request.kind -notin @('tab', 'window') -or $request.direction -notin @('next', 'previous')) { throw 'Unsupported traversal.' }
    if (-not [JarvinWin32]::Traverse(($request.kind -eq 'window'), ($request.direction -eq 'previous'))) { throw 'Windows did not accept the traversal shortcut.' }
    Start-Sleep -Milliseconds 180
    $after = [JarvinWin32]::GetForegroundWindow()
    $changed = $after -ne $h
    $title = ''
    $appName = ''
    $center = $null
    if ($after -ne [IntPtr]::Zero) {
      try { $identity = WindowIdentity $after; $title = $identity.title; $appName = $identity.app } catch { }
      $bounds = [JarvinWin32+RECT]::new()
      if ([JarvinWin32]::GetWindowRect($after, [ref]$bounds)) {
        $center = @{ x = [int](($bounds.Left + $bounds.Right) / 2); y = [int](($bounds.Top + $bounds.Bottom) / 2) }
      }
    }
    $result = @{ input_sent = $true; kind = $request.kind; direction = $request.direction; foreground_changed = $changed; foreground_title = $title; foreground_app = $appName; foreground_center = $center; note = 'Traversal keys were sent. Capture the screen to verify the selected tab or window.' }
  } elseif ($request.op -eq 'send_keys') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. No keyboard input was sent.' }
    if ($request.kind -eq 'text') {
      $keys = [regex]::Replace([string]$request.text, '[+^%~(){}\[\]]', { param($match) '{' + $match.Value + '}' })
      $keys = $keys.Replace("`r`n", '{ENTER}').Replace("`n", '{ENTER}').Replace("`r", '{ENTER}').Replace("`t", '{TAB}')
    } elseif ($request.kind -eq 'key') {
      $allowed = @('{ENTER}', '{TAB}', '{ESC}', '{BACKSPACE}', '{DELETE}', '{HOME}', '{END}', '{PGUP}', '{PGDN}', '{UP}', '{DOWN}', '{LEFT}', '{RIGHT}', '^l', '^a', '^c', '^v', '^t', '^z', '^f', '^s', '^+s', '^n', '^o', '^x', '^y', '^w', '^r', '^d', '^{TAB}', '^+{TAB}', '^{HOME}', '^{END}', '{F2}', '{F5}', '{F6}', '%{LEFT}', '%{RIGHT}')
      $keys = [string]$request.keys
      if ($keys -cnotin $allowed) { throw 'Unsupported keyboard sequence.' }
    } else { throw 'Unsupported keyboard operation.' }
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. No keyboard input was sent.' }
    if ($request.kind -eq 'text') {
      # Send a few characters at a time with a short pause: one big SendWait drops letters in some apps.
      $tokens = [regex]::Matches($keys, '\{[^{}]+\}|\{[+^%~(){}\[\]]\}|.', 'Singleline') | ForEach-Object { $_.Value }
      $batch = ''; $count = 0
      foreach ($t in $tokens) {
        $batch += $t; $count++
        if ($count -ge 3) {
          if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed while typing. Typing stopped.' }
          [System.Windows.Forms.SendKeys]::SendWait($batch); Start-Sleep -Milliseconds 25; $batch = ''; $count = 0
        }
      }
      if ($batch) { [System.Windows.Forms.SendKeys]::SendWait($batch) }
    } else { [System.Windows.Forms.SendKeys]::SendWait($keys) }
    $result = @{ sent = $true; note = 'Keyboard input sent. Capture another image to verify the result.' }
  } elseif ($request.op -eq 'move_pointer') {
    $h = CheckedWindow $request
    $pt = [JarvinWin32+POINT]::new(); $pt.X = [int]$request.x; $pt.Y = [int]$request.y
    if ([JarvinWin32]::GetForegroundWindow() -ne $h -or [JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'The target is outside the foreground window or obscured. Pointer was not moved.' }
    if (-not [JarvinWin32]::SetCursorPos($pt.X, $pt.Y)) { throw 'Could not move the pointer.' }
    $result = @{ moved = $true; x = $pt.X; y = $pt.Y }
  } elseif ($request.op -eq 'scroll') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. No scroll was sent.' }
    $r = [JarvinWin32+RECT]::new()
    if (-not [JarvinWin32]::GetWindowRect($h, [ref]$r)) { throw 'Could not locate the window. No scroll was sent.' }
    $pt = [JarvinWin32+POINT]::new(); $pt.X = [int](($r.Left + $r.Right) / 2); $pt.Y = [int](($r.Top + $r.Bottom) / 2)
    if ([JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'The center of the window is obscured. No scroll was sent.' }
    if (-not [JarvinWin32]::SetCursorPos($pt.X, $pt.Y)) { throw 'Could not move the pointer. No scroll was sent.' }
    if ([JarvinWin32]::GetForegroundWindow() -ne $h -or [JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'Window focus changed. No scroll was sent.' }
    $delta = if ($request.direction -eq 'up') { 120 * [int]$request.amount } elseif ($request.direction -eq 'down') { -120 * [int]$request.amount } else { throw 'Invalid scroll direction.' }
    if (-not [JarvinWin32]::MouseScroll($delta)) { throw 'Windows did not accept the scroll input.' }
    $result = @{ sent = $true; direction = $request.direction; note = 'Scroll input sent. Capture a fresh image to verify the result.' }
  } elseif ($request.op -eq 'window_manage') {
    $h = CheckedWindow $request
    if ($request.action -eq 'move') {
      if ([JarvinWin32]::IsIconic($h)) { throw 'Restore the window before moving it.' }
      if (-not [JarvinWin32]::SetWindowPos($h, [IntPtr]::Zero, [int]$request.x, [int]$request.y, 0, 0, 0x0015)) { throw 'Windows could not move this window.' }
    } elseif ($request.action -eq 'minimize') { [void][JarvinWin32]::ShowWindow($h, 6) }
    elseif ($request.action -eq 'maximize') { [void][JarvinWin32]::ShowWindow($h, 3) }
    elseif ($request.action -eq 'restore') { [void][JarvinWin32]::ShowWindow($h, 9) }
    elseif ($request.action -in @('snap_left', 'snap_right', 'snap_top', 'snap_bottom')) {
      # Fill one half of the monitor the window is on (work area = screen minus taskbar).
      $wa = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
      [void][JarvinWin32]::ShowWindow($h, 9)
      $hw = [int]($wa.Width / 2); $hh = [int]($wa.Height / 2)
      switch ($request.action) {
        'snap_left'   { $nx = $wa.X;        $ny = $wa.Y;        $nw = $hw;       $nh = $wa.Height }
        'snap_right'  { $nx = $wa.X + $hw;  $ny = $wa.Y;        $nw = $wa.Width - $hw; $nh = $wa.Height }
        'snap_top'    { $nx = $wa.X;        $ny = $wa.Y;        $nw = $wa.Width; $nh = $hh }
        'snap_bottom' { $nx = $wa.X;        $ny = $wa.Y + $hh;  $nw = $wa.Width; $nh = $wa.Height - $hh }
      }
      if (-not [JarvinWin32]::SetWindowPos($h, [IntPtr]::Zero, [int]$nx, [int]$ny, [int]$nw, [int]$nh, 0x0014)) { throw 'Windows could not resize this window.' }
    }
    else { throw 'Unsupported window action.' }
    $r = [JarvinWin32+RECT]::new(); [void][JarvinWin32]::GetWindowRect($h, [ref]$r)
    $result = @{ action = $request.action; bounds = @{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }; minimized = [JarvinWin32]::IsIconic($h); note = 'Window request sent. Observe the desktop to verify the result.' }
  } elseif ($request.op -eq 'click_point') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'The foreground window changed. No click was sent.' }
    $pt = [JarvinWin32+POINT]::new(); $pt.X = [int]$request.x; $pt.Y = [int]$request.y
    if ([JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'The target is obscured or is outside the pinned foreground window. No click was sent. List and focus the intended window, then locate the target again.' }
    if (-not [JarvinWin32]::SetCursorPos($pt.X, $pt.Y)) { throw 'Could not move the pointer.' }
    if ([JarvinWin32]::GetForegroundWindow() -ne $h -or [JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'Window focus changed. No click was sent.' }
    if (-not [JarvinWin32]::MouseClick()) { throw 'Windows did not accept the click input.' }
    $result = @{ action = 'click'; x = $pt.X; y = $pt.Y; note = 'Click sent. Capture another image to verify the result.' }
  } elseif ($request.op -eq 'focus') {
    $h = CheckedWindow $request
    if ([JarvinWin32]::IsIconic($h)) { [void][JarvinWin32]::ShowWindow($h, 9) }
    for ($attempt = 0; $attempt -lt 3 -and [JarvinWin32]::GetForegroundWindow() -ne $h; $attempt++) {
      [void][JarvinWin32]::ShowWindow($h, 5)
      # Windows refuses to move another app's window to the front unless this process recently had input.
      # A synthetic Alt tap plus attaching to the foreground thread's input queue lifts that restriction.
      [uint32]$fgPid = 0; [uint32]$tgtPid = 0
      $fgThread = [JarvinWin32]::GetWindowThreadProcessId([JarvinWin32]::GetForegroundWindow(), [ref]$fgPid)
      $tgtThread = [JarvinWin32]::GetWindowThreadProcessId($h, [ref]$tgtPid)
      $me = [JarvinWin32]::GetCurrentThreadId()
      [void][JarvinWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [void][JarvinWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      $a1 = ($fgThread -ne 0 -and $fgThread -ne $me) -and [JarvinWin32]::AttachThreadInput($me, $fgThread, $true)
      $a2 = ($tgtThread -ne 0 -and $tgtThread -ne $me -and $tgtThread -ne $fgThread) -and [JarvinWin32]::AttachThreadInput($me, $tgtThread, $true)
      [void][JarvinWin32]::BringWindowToTop($h)
      [void][JarvinWin32]::SetForegroundWindow($h)
      if ($a1) { [void][JarvinWin32]::AttachThreadInput($me, $fgThread, $false) }
      if ($a2) { [void][JarvinWin32]::AttachThreadInput($me, $tgtThread, $false) }
      Start-Sleep -Milliseconds 150
    }
    if ([JarvinWin32]::GetForegroundWindow() -ne $h) {
      $active = [JarvinWin32]::GetForegroundWindow(); [uint32]$activePid = 0
      [void][JarvinWin32]::GetWindowThreadProcessId($active, [ref]$activePid)
      # Store apps can have a stale twin frame with the same title; if the window already in front has that title, the app is in front.
      $activeTitle = [Text.StringBuilder]::new(512); [void][JarvinWin32]::GetWindowText($active, $activeTitle, 512)
      if ($activeTitle.Length -gt 0 -and $activeTitle.ToString() -eq [string]$request.window.title -and [JarvinWin32]::IsWindowVisible($active) -and -not [JarvinWin32]::IsIconic($active)) {
        return @{ focused = $true; note = 'A window with the same title is already in front.' }
      }
      throw "Windows did not bring this window to the foreground (target pid $($request.window.pid), active pid $activePid)."
    }
    [void](CheckedWindow $request)
    $result = @{ focused = $true }
  } elseif ($request.op -eq 'check') {
    [void](CheckedWindow $request)
    $result = @{ ok = $true }
  } elseif ($request.op -eq 'inspect') {
    $h = CheckedWindow $request
    $result = WalkControls $h
  } elseif ($request.op -eq 'act') {
    $h = CheckedWindow $request
    $el = FindControl $h ([string]$request.runtime)
    $c = $el.Current
    if ($c.IsPassword -or $c.IsOffscreen -or -not $c.IsEnabled) { throw 'This control is protected, hidden or disabled.' }
    if ($c.ControlType.ProgrammaticName.Replace('ControlType.','') -ne [string]$request.role -or [string]$c.Name -ne [string]$request.name) { throw 'Control changed since inspection. Inspect it again.' }
    if ($request.action -eq 'set_value') {
      $pattern = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -or $pattern.Current.IsReadOnly) { throw 'This control does not support editable values.' }
      $pattern.SetValue([string]$request.text)
      $result = @{ action = 'set_value'; value_matches = ($pattern.Current.Value -ceq [string]$request.text); note = 'The application may process the value later; inspect again to verify the task.' }
    } else {
      if ([JarvinWin32]::IsIconic($h)) { [void][JarvinWin32]::ShowWindow($h, 9) }
      [void][JarvinWin32]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 100
      if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'Could not focus the target window. No input was sent.' }
      [void](CheckedWindow $request)
      $c = $el.Current
      if ($c.IsPassword -or $c.IsOffscreen -or -not $c.IsEnabled -or $c.ControlType.ProgrammaticName.Replace('ControlType.','') -ne [string]$request.role -or [string]$c.Name -ne [string]$request.name) { throw 'Control changed while focusing the window. No input was sent.' }
      if ($request.action -eq 'click') {
        $r = $c.BoundingRectangle
        if ($r.IsEmpty -or $r.Width -lt 2 -or $r.Height -lt 2) { throw 'Control has no clickable area.' }
        $pt = [JarvinWin32+POINT]::new(); $pt.X = [int]($r.X + $r.Width / 2); $pt.Y = [int]($r.Y + $r.Height / 2)
        $at = [JarvinWin32]::WindowFromPoint($pt)
        if ([JarvinWin32]::GetAncestor($at, 2) -ne $h) { throw 'The control is obscured by another window. No click was sent.' }
        if (-not [JarvinWin32]::SetCursorPos($pt.X, $pt.Y)) { throw 'Could not move the pointer.' }
        if ([JarvinWin32]::GetForegroundWindow() -ne $h -or [JarvinWin32]::GetAncestor([JarvinWin32]::WindowFromPoint($pt), 2) -ne $h) { throw 'Window focus changed. No click was sent.' }
        if (-not [JarvinWin32]::MouseClick()) { throw 'Windows did not accept the click input.' }
        $result = @{ action = 'click'; x = $pt.X; y = $pt.Y; note = 'Click sent. Inspect the window again to verify the result.' }
      } elseif ($request.action -eq 'enter') {
        $el.SetFocus()
        if ([JarvinWin32]::GetForegroundWindow() -ne $h) { throw 'Window focus changed. No key was sent.' }
        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
        $result = @{ action = 'enter'; note = 'Enter sent. Inspect the window again to verify the result.' }
      } else { throw 'Unsupported desktop action.' }
    }
  } else { throw 'Unsupported desktop operation.' }
  return $result
}

if ($Server) {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $envelope = $null
    try {
      $envelope = $line | ConvertFrom-Json
      $result = Invoke-DesktopRequest $envelope.request
      $reply = @{ id = $envelope.id; result = $result }
    } catch { $reply = @{ id = $envelope.id; error = [string]$_.Exception.Message } }
    [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 10 -Compress))
    [Console]::Out.Flush()
  }
} else {
  try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $result = Invoke-DesktopRequest $request
    [Console]::Out.Write(($result | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    [Console]::Error.Write(([string]$_.Exception.Message))
    exit 1
  }
}
