# Generate one WAV per narration line with the installed zh-CN voice.
# Rate is nudged slightly slower than default: the script reads as a product film,
# not a notification.
Add-Type -AssemblyName System.Speech
$outDir = 'E:\IEXA-WIN\.video\vo'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$lines = [ordered]@{
  '00-intro'     = 'IEXA，把 AI 代理放进你的 Windows 桌面。'
  '01-hero'      = '一个本地优先的 AI 工作台。模型在云端，手脚在你的机器上。'
  '02-chat'      = '对话只是入口。思考、工具、计划，每一步都看得见。'
  '03-insights'  = '上下文洞察，把 Token 构成、耗时分布和用量趋势摊开。'
  '04-chart'     = '模型可以直接画图。折线、柱状，可悬停，能切换成表格。'
  '05-doc'       = '长文档在同一个窗口里写。分栏预览、自动保存、撤销重做。'
  '06-appearance'= '八套皮肤，也可以自己调配色、圆角和字号。'
  '07-scheduled' = '定时任务按系统时间自动执行，到点就跑。'
  '08-pet'       = '上传一张图，本地抠图，拖到桌面上当宠物。'
  '09-paused'    = '随时暂停，工具结果和进度都保留，继续时接着跑。'
  '10-settings'  = '多模型档案随时切换，密钥存在本地。'
  '11-outro'     = 'IEXA-WIN。你的私有 Windows AI 代理。'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft Huihui Desktop')
$synth.Rate = -1        # slightly slower than default
$synth.Volume = 100

foreach ($name in $lines.Keys) {
  $path = Join-Path $outDir "$name.wav"
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($lines[$name])
  $synth.SetOutputToNull()
  $bytes = (Get-Item $path).Length
  "wrote {0,-16} {1,7:N0} KB" -f $name, ($bytes / 1KB)
}
$synth.Dispose()
