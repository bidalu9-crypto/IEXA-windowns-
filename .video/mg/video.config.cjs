// Config for the IEXA product film: paths + the shot table.
// `mg.cjs plan` derives every duration from its narration take, so this file is
// the only place timings are decided. There is no second plan script to keep in
// sync — that duplication is what made durations drift before.
const SHOTS = [
  { vo: '00-intro', hero: true, index: '', accent: '#8b7bff',
    title: 'IEXA-WIN', subtitle: '本地优先的 AI 工作台', foot: 'WINDOWS 10 / 11 · ELECTRON',
    logo: 'src/renderer/mobile-pair-logo.png', caption: '' },
  { vo: '01-hero', shot: '01-hero.png', index: '01', label: '本地优先', accent: '#60a5fa', focus: [0.50, 0.62],
    caption: '模型在云端，手脚在你的机器上' },
  { vo: '02-chat', shot: '02-chat.png', index: '02', label: '每一步都可见', accent: '#60a5fa', focus: [0.46, 0.52],
    caption: '思考、工具、计划，全程可见' },
  { vo: '03-insights', shot: '04-insights.png', index: '03', label: '上下文洞察', accent: '#34d399', focus: [0.28, 0.46],
    caption: 'Token 构成、耗时分布、用量趋势' },
  { vo: '04-chart', shot: '05-chart.png', index: '04', label: '交互式图表', accent: '#f59e0b', focus: [0.50, 0.50],
    caption: '折线、柱状，可悬停，能转表格' },
  { vo: '05-doc', shot: '06-doc.png', index: '05', label: '文档工作区', accent: '#a78bfa', focus: [0.34, 0.50],
    caption: '分栏预览、自动保存、撤销重做' },
  { vo: '06-appearance', shot: '08-appearance.png', index: '06', label: '八套皮肤', accent: '#f472b6', focus: [0.50, 0.44],
    caption: '也能自己调配色、圆角与字号' },
  { vo: '07-scheduled', shot: '09-scheduled.png', index: '07', label: '定时任务', accent: '#38bdf8', focus: [0.50, 0.34],
    caption: '按系统时间自动执行，到点就跑' },
  { vo: '08-pet', shot: '10-pet.png', index: '08', label: '桌面宠物', accent: '#fb923c', focus: [0.34, 0.40],
    caption: '一张图，本地抠图，放到桌面' },
  { vo: '09-paused', shot: '11-paused.png', index: '09', label: '暂停与续跑', accent: '#fbbf24', focus: [0.50, 0.56],
    caption: '工具结果与进度都保留' },
  { vo: '10-settings', shot: '12-settings.png', index: '10', label: '多模型档案', accent: '#94a3b8', focus: [0.50, 0.38],
    caption: '随时切换，密钥存在本地' },
  { vo: '11-outro', hero: true, index: '', accent: '#8b7bff',
    title: 'IEXA-WIN', subtitle: '你的私有 Windows AI 代理',
    foot: 'github.com/bidalu9-crypto/IEXA-windowns-', logo: 'src/renderer/mobile-pair-logo.png', caption: '' },
];

module.exports = {
  stage: '.video/mg/stage.html',
  plan: '.video/mg/plan.json',
  build: '.video/build2',
  vo: '.video/vo2',
  shots: '.video-shots',
  output: 'IEXA-WIN-功能介绍.mp4',
  fps: 60,
  width: 1920,
  height: 1080,
  crossfade: 0.58,
  // Scene must hold for its narration plus a tail that survives the crossfade.
  minScene: 3.6,
  tail: 0.92,
  voLead: 0.18,
  crf: 17,
  lufs: -14,
  caption: { font: 'Microsoft YaHei', size: 44, marginV: 84 },
  scenes: () => SHOTS,
};
