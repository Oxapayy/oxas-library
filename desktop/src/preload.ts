import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("oxa", {
  command: async (action: string, args: any = {}) => {
    const r = await ipcRenderer.invoke("oxa:command", action, args);
    if (r.error) throw Error(r.error);
    return r.value;
  },
  onUpdate: (fn: (v: any) => void) => {
    const listener = (_e: any, v: any) => fn(v);
    ipcRenderer.on("oxa:update", listener);
    return () => ipcRenderer.removeListener("oxa:update", listener);
  },
  onAction: (fn: (v: string) => void) => {
    const listener = (_e: any, v: string) => fn(v);
    ipcRenderer.on("oxa:action", listener);
    return () => ipcRenderer.removeListener("oxa:action", listener);
  },
});
