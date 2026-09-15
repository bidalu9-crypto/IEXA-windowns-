"""Owned test host: a separate Windows desktop, never switched to the input desktop.
All child processes enter a kill-on-close job while suspended. This is desktop UI
isolation, not a filesystem/network/credential sandbox. No clipboard or SendInput.
"""
import ctypes as C
from ctypes import wintypes as W
import os, sys, json, time, subprocess
from pathlib import Path
u=C.WinDLL('user32',use_last_error=True); k=C.WinDLL('kernel32',use_last_error=True)
class STARTUPINFO(C.Structure):
 _fields_=[('cb',W.DWORD),('lpReserved',W.LPWSTR),('lpDesktop',W.LPWSTR),('lpTitle',W.LPWSTR),('dwX',W.DWORD),('dwY',W.DWORD),('dwXSize',W.DWORD),('dwYSize',W.DWORD),('dwXCountChars',W.DWORD),('dwYCountChars',W.DWORD),('dwFillAttribute',W.DWORD),('dwFlags',W.DWORD),('wShowWindow',W.WORD),('cbReserved2',W.WORD),('lpReserved2',C.POINTER(C.c_byte)),('hStdInput',W.HANDLE),('hStdOutput',W.HANDLE),('hStdError',W.HANDLE)]
class PROCESS_INFORMATION(C.Structure):
 _fields_=[('hProcess',W.HANDLE),('hThread',W.HANDLE),('dwProcessId',W.DWORD),('dwThreadId',W.DWORD)]
class BASIC_LIMIT(C.Structure):
 _fields_=[('PerProcessUserTimeLimit',C.c_int64),('PerJobUserTimeLimit',C.c_int64),('LimitFlags',W.DWORD),('MinimumWorkingSetSize',C.c_size_t),('MaximumWorkingSetSize',C.c_size_t),('ActiveProcessLimit',W.DWORD),('Affinity',C.c_size_t),('PriorityClass',W.DWORD),('SchedulingClass',W.DWORD)]
class IO_COUNTERS(C.Structure):
 _fields_=[(name,C.c_uint64) for name in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
class EXTENDED_LIMIT(C.Structure):
 _fields_=[('BasicLimitInformation',BASIC_LIMIT),('IoInfo',IO_COUNTERS),('ProcessMemoryLimit',C.c_size_t),('JobMemoryLimit',C.c_size_t),('PeakProcessMemoryUsed',C.c_size_t),('PeakJobMemoryUsed',C.c_size_t)]
def bind(lib,name,result,args):
 f=getattr(lib,name);f.restype=result;f.argtypes=args;return f
CreateDesktop=bind(u,'CreateDesktopW',W.HANDLE,[W.LPCWSTR,W.LPCWSTR,C.c_void_p,W.DWORD,W.DWORD,C.c_void_p])
CloseDesktop=bind(u,'CloseDesktop',W.BOOL,[W.HANDLE])
CreateJob=bind(k,'CreateJobObjectW',W.HANDLE,[C.c_void_p,W.LPCWSTR])
SetJob=bind(k,'SetInformationJobObject',W.BOOL,[W.HANDLE,C.c_int,C.c_void_p,W.DWORD])
AssignJob=bind(k,'AssignProcessToJobObject',W.BOOL,[W.HANDLE,W.HANDLE])
CreateProcess=bind(k,'CreateProcessW',W.BOOL,[W.LPCWSTR,W.LPWSTR,C.c_void_p,C.c_void_p,W.BOOL,W.DWORD,C.c_void_p,W.LPCWSTR,C.POINTER(STARTUPINFO),C.POINTER(PROCESS_INFORMATION)])
ResumeThread=bind(k,'ResumeThread',W.DWORD,[W.HANDLE])
CloseHandle=bind(k,'CloseHandle',W.BOOL,[W.HANDLE])
TerminateProcess=bind(k,'TerminateProcess',W.BOOL,[W.HANDLE,W.UINT])
Wait=bind(k,'WaitForSingleObject',W.DWORD,[W.HANDLE,W.DWORD])
def check(value,label):
 if not value:raise OSError(C.get_last_error(),label)
 return value
out=Path(sys.argv[1]).resolve(); native=Path(sys.argv[2]).resolve();port=int(sys.argv[3]);document=Path(sys.argv[4]).resolve()
name='IEXA-Owned-'+str(os.getpid())+'-'+str(time.time_ns())
job=desktop=None;processes=[];report={'desktopName':name,'hostPid':os.getpid(),'children':[],'inputDesktopSwitched':False}
def save(file,data): (out/file).write_text(json.dumps(data,indent=2),encoding='utf-8')
def launch(executable,args,role):
 si=STARTUPINFO();si.cb=C.sizeof(si);si.lpDesktop='winsta0\\'+name
 pi=PROCESS_INFORMATION();line=C.create_unicode_buffer(subprocess.list2cmdline([str(executable),*map(str,args)]))
 check(CreateProcess(str(executable),line,None,None,False,4,None,str(out),C.byref(si),C.byref(pi)),'CreateProcessW')
 try:
  check(AssignJob(job,pi.hProcess),'AssignProcessToJobObject')
  if ResumeThread(pi.hThread)==0xFFFFFFFF:raise OSError(C.get_last_error(),'ResumeThread')
 except BaseException:
  TerminateProcess(pi.hProcess,1);CloseHandle(pi.hProcess);raise
 finally:CloseHandle(pi.hThread)
 processes.append(pi);entry={'role':role,'pid':pi.dwProcessId,'executable':str(executable)};report['children'].append(entry)
try:
 desktop=check(CreateDesktop(name,None,None,0,0x1FF,None),'CreateDesktopW')
 job=check(CreateJob(None,None),'CreateJobObjectW');limits=EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=0x2000
 check(SetJob(job,9,C.byref(limits),C.sizeof(limits)),'SetInformationJobObject')
 os.environ['IEXA_DESKTOP_PORT']=str(port)
 launch(native,[],'agent')
 launch(Path(os.environ['WINDIR'])/'System32/notepad.exe',[document],'notepad')
 save('isolated-ready.json',report)
 deadline=time.monotonic()+240
 while not (out/'stop-host').exists() and time.monotonic()<deadline:
  if any(Wait(p.hProcess,0)==0 for p in processes):raise RuntimeError('An owned process exited unexpectedly')
  time.sleep(.1)
except BaseException as e:
 report['error']=str(e);save('isolated-error.json',report);raise
finally:
 if job:CloseHandle(job)
 for p in processes:
  report.setdefault('cleanup',[]).append({'pid':p.dwProcessId,'waitResult':Wait(p.hProcess,5000)})
  CloseHandle(p.hProcess)
 if desktop:report['desktopClosed']=bool(CloseDesktop(desktop))
 save('isolated-ended.json',report)
