// Visible Chromium acceptance host. Own isolated Electron profile, no Node in pages,
// no window activation; caller verifies the foreground event stream independently.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const out=process.env.IEXA_CDP_TEST_OUT;
const url=process.env.IEXA_CDP_TEST_URL;
if(!out||!url||!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))process.exit(2);
app.setPath('userData',path.join(out,'electron-profile'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.IEXA_CDP_TEST_PORT);
let window, second, creatingSecond=false;
app.whenReady().then(async()=>{
 window=new BrowserWindow({show:false,width:900,height:650,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await window.loadURL(url);
 window.showInactive();
 fs.writeFileSync(path.join(out,'visible-ready.json'),JSON.stringify({pid:process.pid,visible:window.isVisible(),focused:window.isFocused(),electron:process.versions.electron,chrome:process.versions.chrome}));
 const timer=setInterval(async()=>{
  if(fs.existsSync(path.join(out,'stop'))){clearInterval(timer);app.quit();return;}
  if(fs.existsSync(path.join(out,'create-second'))&&!second&&!creatingSecond){
   creatingSecond=true;
   second=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
   await second.loadURL(url+'second');fs.writeFileSync(path.join(out,'second-ready'),'');
  }
  if(fs.existsSync(path.join(out,'close-second'))&&second){second.destroy();second=null;}
 },50);
}).catch(e=>{console.error(e);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
