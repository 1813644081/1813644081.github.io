"""Small local control window; the actual collector runs in the background."""
import json
import os
import subprocess
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

ROOT=Path(__file__).resolve().parent
DATA=ROOT/"data"
PYTHON=ROOT/"runtime"/"venv"/"Scripts"/"python.exe"
BACKEND=ROOT/"runtime"/"napcat-node-v4.18.38"


class Panel:
    def __init__(self):
        self.window=tk.Tk()
        self.window.title("幽幽子 · Minecraft 物品采集")
        self.window.geometry("790x610")
        self.worker=None
        DATA.mkdir(parents=True,exist_ok=True)
        outer=ttk.Frame(self.window,padding=18)
        outer.pack(fill="both",expand=True)
        ttk.Label(outer,text="Minecraft 物品采集",font=("Microsoft YaHei UI",19,"bold")).pack(anchor="w")
        ttk.Label(outer,text="后台与幽幽子对话，保存原始图片、物品标签和采集进度。箭头不参与识别。").pack(anchor="w",pady=(8,16))
        self.status=tk.StringVar(value="准备就绪")
        ttk.Label(outer,textvariable=self.status,font=("Microsoft YaHei UI",12)).pack(anchor="w")
        login=ttk.Frame(outer)
        login.pack(fill="x",pady=12)
        ttk.Button(login,text="启动 QQ 后台",command=self.start_backend).pack(side="left",padx=(0,8))
        ttk.Button(login,text="打开扫码登录",command=self.open_login).pack(side="left",padx=(0,8))
        ttk.Button(login,text="检查连接",command=lambda:self.run("status")).pack(side="left")
        settings=json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
        target=ttk.Frame(outer)
        target.pack(fill="x",pady=(0,12))
        ttk.Label(target,text="机器人 QQ 号：").pack(side="left")
        self.target=tk.StringVar(value=str(settings.get("target_user_id","")))
        ttk.Entry(target,textvariable=self.target,width=23).pack(side="left",padx=(0,8))
        ttk.Label(target,text="留空会自动查找“幽幽子”").pack(side="left")
        actions=ttk.Frame(outer)
        actions.pack(fill="x",pady=(0,12))
        for label,command in (("读取已有回复",lambda:self.run("history")),
                              ("试采集 3 项",lambda:self.run("collect","--limit","3")),
                              ("采集剩余物品",lambda:self.run("collect","--limit","0")),
                              ("暂停采集",self.pause),
                              ("打开数据文件夹",lambda:os.startfile(DATA))):
            ttk.Button(actions,text=label,command=command).pack(side="left",padx=(0,7))
        ttk.Label(outer,text=f"收到回复后间隔 {settings.get('interval_seconds',5)} 秒；自动开局及复查别名。数据保存为 JSON 和 CSV，可随时暂停。").pack(anchor="w",pady=(0,10))
        self.text=tk.Text(outer,height=15,wrap="word",font=("Microsoft YaHei UI",10),background="#f8fafc")
        self.text.pack(fill="both",expand=True)
        self.window.after(1000,self.refresh)
        self.window.protocol("WM_DELETE_WINDOW",self.close)

    def start_backend(self):
        import socket
        with socket.socket() as connection:
            connection.settimeout(.5)
            if connection.connect_ex(("127.0.0.1",6099))==0:
                self.open_login()
                return
        out=(DATA/"backend.stdout.log").open("a",encoding="utf-8")
        err=(DATA/"backend.stderr.log").open("a",encoding="utf-8")
        process=subprocess.Popen([str(BACKEND/"node.exe"),"index.js"],cwd=BACKEND,
            stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
        out.close();err.close()
        (DATA/"backend.pid").write_text(str(process.pid))
        self.status.set("QQ 后台启动中，稍后打开扫码登录")
        self.window.after(4000,self.open_login)

    def open_login(self):
        settings=json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
        webbrowser.open("http://127.0.0.1:6099/webui?token="+settings["webui_token"])

    def run(self,*arguments):
        if self.worker and self.worker.poll() is None:
            messagebox.showinfo("正在运行","当前操作尚未完成。需要停止时请点击“暂停采集”。")
            return
        target=self.target.get().strip()
        if target and not target.isdigit():
            messagebox.showerror("QQ 号格式","机器人 QQ 号应只包含数字。")
            return
        settings=json.loads((ROOT/"config.json").read_text(encoding="utf-8"))
        settings["target_user_id"]=target
        (ROOT/"config.json").write_text(json.dumps(settings,ensure_ascii=False,indent=2),encoding="utf-8")
        (DATA/"STOP").unlink(missing_ok=True)
        log=(DATA/"worker.stdout.log").open("a",encoding="utf-8")
        self.worker=subprocess.Popen([str(PYTHON),"-X","utf8",str(ROOT/"collector.py"),*arguments],
            cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
        log.close()
        (DATA/"collector.pid").write_text(str(self.worker.pid))
        self.status.set("操作已开始，采集会在后台进行")

    def pause(self):
        (DATA/"STOP").touch()
        self.status.set("已请求暂停；当前回复处理完后保存进度")

    def refresh(self):
        try:
            progress=json.loads((DATA/"progress.json").read_text(encoding="utf-8"))
            count=len(json.loads((DATA/"items.json").read_text(encoding="utf-8"))) if (DATA/"items.json").exists() else 0
            label=f"{progress.get('state','就绪')}  ·  已保存 {count} 个物品"
            if progress.get("current_item"):
                label+="  ·  "+progress["current_item"]
            self.status.set(label)
        except (OSError,ValueError):
            pass
        try:
            content=(DATA/"collector.log").read_text(encoding="utf-8")[-6000:]
            if self.text.get("1.0","end-1c")!=content:
                self.text.delete("1.0","end")
                self.text.insert("1.0",content)
                self.text.see("end")
        except OSError:
            pass
        self.window.after(1000,self.refresh)

    def close(self):
        if self.worker and self.worker.poll() is None:
            if not messagebox.askyesno("后台采集","关闭面板后继续后台采集吗？选择“否”会请求暂停。"):
                self.pause()
        self.window.destroy()


if __name__=="__main__":
    Panel().window.mainloop()
