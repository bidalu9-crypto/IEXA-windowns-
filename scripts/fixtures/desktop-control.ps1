param([string]$Title = 'IEXA Desktop Control Fixture')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Name = 'IexaControlFixture'
$form.Size = New-Object System.Drawing.Size(500, 260)
$form.StartPosition = 'CenterScreen'
$edit = New-Object System.Windows.Forms.TextBox
$edit.Name = 'FixtureInput'
$edit.AccessibleName = 'Fixture input'
$edit.Location = New-Object System.Drawing.Point(25, 30)
$edit.Size = New-Object System.Drawing.Size(430, 30)
$button = New-Object System.Windows.Forms.Button
$button.Name = 'FixtureApply'
$button.Text = 'Apply fixture'
$button.Location = New-Object System.Drawing.Point(25, 85)
$button.Size = New-Object System.Drawing.Size(160, 35)
$label = New-Object System.Windows.Forms.Label
$label.Name = 'FixtureResult'
$label.Text = 'Waiting for input'
$label.Location = New-Object System.Drawing.Point(25, 140)
$label.Size = New-Object System.Drawing.Size(430, 35)
$button.Add_Click({ $label.Text = 'Applied ' + $edit.Text })
$form.Controls.AddRange(@($edit, $button, $label))
[System.Windows.Forms.Application]::Run($form)
