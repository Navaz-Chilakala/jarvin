$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms
$originalCursor = [System.Windows.Forms.Cursor]::Position
$window = [System.Windows.Window]::new()
$window.Title = $env:JARVIN_FIXTURE_TITLE
$window.Width = 460; $window.Height = 220
$window.WindowStartupLocation = 'Manual'; $window.Left = 100; $window.Top = 100
$window.ShowInTaskbar = $false
$panel = [System.Windows.Controls.StackPanel]::new(); $panel.Margin = '20'
$label = [System.Windows.Controls.TextBlock]::new(); $label.Text = 'Waiting for the test'; $label.Margin = '0,0,0,10'
$textbox = [System.Windows.Controls.TextBox]::new(); $textbox.Width = 260; $textbox.HorizontalAlignment = 'Left'; $textbox.Margin = '0,0,0,10'
[System.Windows.Automation.AutomationProperties]::SetName($textbox, 'Test input')
$button = [System.Windows.Controls.Button]::new(); $button.Content = 'Apply test'; $button.Width = 125; $button.Height = 35; $button.HorizontalAlignment = 'Left'
$button.Add_Click({ $label.Text = 'Applied: ' + $textbox.Text })
[void]$panel.Children.Add($label); [void]$panel.Children.Add($textbox); [void]$panel.Children.Add($button); $window.Content = $panel
$timer = [System.Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromMilliseconds(250)
$timer.Add_Tick({ if (Test-Path -LiteralPath $env:JARVIN_FIXTURE_STOP) { $timer.Stop(); $window.Close() } })
$window.Add_ContentRendered({ $timer.Start() })
$window.Add_Closed({
  $point = $button.PointToScreen([System.Windows.Point]::new($button.ActualWidth / 2, $button.ActualHeight / 2))
  $current = [System.Windows.Forms.Cursor]::Position
  if ([Math]::Abs($current.X - $point.X) -lt 4 -and [Math]::Abs($current.Y - $point.Y) -lt 4) { [System.Windows.Forms.Cursor]::Position = $originalCursor }
})
[void]$window.ShowDialog()
