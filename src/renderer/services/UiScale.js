/* Independent text/icon scaling. Font rules use a CSS factor, SVGs keep their
   own factor; this deliberately does not zoom the complete page. */
(function(root){
  'use strict';
  const normalize = (value, max) => {const n=Number(value);return Number.isFinite(n)?Math.round(Math.max(100,Math.min(max,n))):100;};
  function current(){return {fontScale:normalize(document.documentElement.dataset.fontScale||100,180),iconScale:normalize(document.documentElement.dataset.iconScale||100,160)};}
  function apply(value, persist=true){
    const fontScale=normalize(value?.fontScale??100,180),iconScale=normalize(value?.iconScale??100,160);
    const html=document.documentElement;
    html.dataset.fontScale=String(fontScale);html.dataset.iconScale=String(iconScale);
    html.dataset.uiScaled=String(fontScale!==100||iconScale!==100);
    html.style.setProperty('--ui-font-scale',String(fontScale/100));html.style.setProperty('--ui-icon-scale',String(iconScale/100));
    if(persist)try{localStorage.setItem('iexa-font-scale',String(fontScale));localStorage.setItem('iexa-icon-scale',String(iconScale));}catch{/* current window still applies */}
    return {fontScale,iconScale};
  }
  function sync(){const values=current();for(const [key,id] of [['fontScale','uiFontScale'],['iconScale','uiIconScale']]){const slider=document.getElementById(id),output=document.getElementById(id+'Value');if(slider){slider.value=String(values[key]);slider.setAttribute('aria-valuetext',values[key]+'%');}if(output)output.textContent=values[key]+'%';}}
  root.IexaUiScale={current,apply,sync};
})(window);
