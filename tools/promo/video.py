"""9:16 promo video (1080x1920, 30 fps, ~42 s) with a generated chiptune soundtrack.

Output: promo/claude-ojousama-promo.mp4
Usage:  python tools/promo/video.py [--preview]   (--preview writes a few still frames only)
"""
import math
import os
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw

from common import (CODE_BG, CREAM, GREEN, INK, MANIFEST, MUTED, ORANGE, ORANGE_D, OUT, SUN, bubble, ease, font,
                    frame_at, mono, outlined, paste_sprite, pixel_box, scaled, sign_text, sunflower, taskbar, wallpaper,
                    window)

W, H, FPS = 1080, 1920, 30
K = 3
FLOOR = 1690  # her feet on the "taskbar" line
TB_Y = 1700
FFMPEG = "ffmpeg"

BG = wallpaper(W, H, top=(255, 220, 178), bottom=(255, 244, 228))


def caption(img, text, sub=None, t=1.0):
    """Big subtitle near the top, popping in."""
    d = ImageDraw.Draw(img)
    a = ease(t * 4)
    y = 230 - (1 - a) * 40
    f = font(70, True)
    outlined(d, (W / 2, y), text, f, fill=CREAM, outline=INK, w=8)
    if sub:
        d.text((W / 2, y + 92), sub, font=font(38), fill=INK, anchor="mm")


def desk(img):
    taskbar(img, TB_Y, 110, k=4)


def typed(text, t, cps=22):
    return int(max(0, t) * cps)


# ------------------------------------------------------------------ scenes (each gets local time t, length L)

def s_intro(img, t, L):
    d = ImageDraw.Draw(img)
    sunflower(img, 150, 380, 60)
    sunflower(img, 930, 520, 44)
    a = ease(t / 0.8)
    outlined(d, (W / 2, 300 - (1 - a) * 60), "我的桌面", font(110, True), fill=CREAM, outline=INK, w=10)
    outlined(d, (W / 2, 440 - (1 - a) * 60), "住进了一位大小姐", font(100, True), fill=(255, 196, 120), outline=INK, w=10)
    desk(img)
    # she drops in from the top and lands
    land = 1.0
    if t < land:
        y = -300 + (FLOOR + 300) * (t / land) ** 2
        paste_sprite(img, "dangle", t, 6, W / 2, y, shadow=False)
    else:
        name = "surprise" if t < land + 0.8 else "wave"
        paste_sprite(img, name, t - land, 6, W / 2, FLOOR, loop=None if name == "wave" else False)
        if t > land + 0.9:
            bubble(img, W / 2 + 40, 860, "你好呀～我是 Claude 大小姐！", k=K, width=700, size=44,
                   max_chars=typed(None, t - land - 0.9), tail_x=W / 2)


def s_typing(img, t, L):
    caption(img, "你写代码，她陪你写", "有自己的小电脑哦", t)
    desk(img)
    box = window(img, (90, 520, 990, 1080), "main.py — VS Code", k=3, dark=True)
    d = ImageDraw.Draw(img)
    lines = ["def load_users(path):", "    with open(path) as f:", "        rows = json.load(f)", "    return [User(**r) for r in rows"]
    shown = typed(None, t, 34)
    for i, ln in enumerate(lines):
        part = ln[: max(0, shown)]
        shown -= len(ln)
        d.text((box[0] + 30, box[1] + 30 + i * 52), part, font=mono(34), fill=(220, 220, 220) if i else (156, 220, 254))
    paste_sprite(img, "typing", t, 6, W / 2, FLOOR)


def s_error(img, t, L):
    caption(img, "报错了？她拿着放大镜来了", "真的会看你的屏幕", t)
    desk(img)
    box = window(img, (90, 400, 990, 760), "main.py — VS Code", k=3, dark=True)
    d = ImageDraw.Draw(img)
    rows = [("    return [User(**r) for r in rows", (220, 220, 220)), ("", 0), ("$ python main.py", (157, 255, 157)),
            ("SyntaxError: '[' was never closed", (255, 110, 90))]
    for i, (ln, c) in enumerate(rows):
        if ln:
            d.text((box[0] + 30, box[1] + 30 + i * 56), ln, font=mono(32), fill=c)
    if int(t * 3) % 2 == 0:
        d.rectangle([box[0] + 20, box[1] + 22, box[2] - 20, box[1] + 76], outline=(255, 110, 90), width=4)
    # walk in from the right, then magnify
    if t < 1.2:
        x = W + 150 - (W / 2 + 280) * ease(t / 1.2)
        paste_sprite(img, "walk", t, 5, x, FLOOR, flip=True)
    else:
        paste_sprite(img, "magnify", t, 5, W / 2 - 130, FLOOR)
        if t > 1.5:
            pressed = 0 if t > L - 0.9 else None
            bubble(img, W / 2 + 40, 1060, "第 1 行少了个 ] 呀～要我帮你补上吗？", k=K, width=760, size=42,
                   buttons=["好呀", "不用"], pressed=pressed, max_chars=typed(None, t - 1.5), tail_x=W / 2 - 100)
            if t > L - 0.9:
                cursor(img, W / 2 - 300, 1020, t)


def cursor(img, x, y, t):
    d = ImageDraw.Draw(img)
    pts = [(x, y), (x, y + 60), (x + 16, y + 46), (x + 28, y + 72), (x + 38, y + 67), (x + 26, y + 42), (x + 46, y + 42)]
    d.polygon(pts, fill=(255, 255, 255), outline=INK)
    d.line(pts + [pts[0]], fill=INK, width=4)


def s_fixed(img, t, L):
    caption(img, "点一下「好呀」", "她真的去做，做完告诉你", t)
    desk(img)
    box = window(img, (90, 400, 990, 760), "main.py — VS Code", k=3, dark=True)
    d = ImageDraw.Draw(img)
    d.text((box[0] + 30, box[1] + 30), "    return [User(**r) for r in rows]", font=mono(32), fill=(220, 220, 220))
    d.text((box[0] + 30, box[1] + 142), "$ python main.py", font=mono(32), fill=(157, 255, 157))
    d.text((box[0] + 30, box[1] + 198), "✔ loaded 128 users", font=mono(32), fill=(157, 255, 157))
    paste_sprite(img, "thumbsup", t, 6, W / 2, FLOOR)
    bubble(img, W / 2 + 30, 1000, "修好啦！已经能跑了～", k=K, width=560, size=44, max_chars=typed(None, t - 0.2), tail_x=W / 2)


def s_remind(img, t, L):
    caption(img, "提醒没理？她会再来", "敲敲屏幕，直到你看到", t)
    desk(img)
    shake = 0
    if 1.3 < t < 2.2 or 2.8 < t < 3.6:
        shake = math.sin(t * 60) * 10
    name = "wave" if t < 1.3 else "squish" if t < 2.8 else "angry"
    txt = "16:00 交周报啦～" if t < 1.3 else "还没回我呢…" if t < 2.8 else "最后提醒一次！"
    paste_sprite(img, name, t, 6, W / 2 + shake, FLOOR)
    bubble(img, W / 2 + shake, 1000, "⏰ " + txt, k=K, width=560, size=46)


def s_note(img, t, L):
    caption(img, "待办写成便签", "她亲手拖到桌面贴好", t)
    desk(img)
    d = ImageDraw.Draw(img, "RGBA")
    p = ease(t / (L - 0.8))
    note_x = 1000 - 520 * p
    note = (note_x, 900, note_x + 420, 1320)
    pixel_box(img, note, fill=(255, 236, 150), k=3)
    d.text((note[0] + 30, note[1] + 26), "📌 今天要做", font=font(36, True), fill=INK)
    for i, txt in enumerate(["提交周报", "修复登录 bug", "18:30 写小结"]):
        y = note[1] + 100 + i * 70
        d.rectangle([note[0] + 34, y, note[0] + 66, y + 32], outline=INK, width=3, fill=(255, 250, 230))
        d.text((note[0] + 84, y + 16), txt, font=font(32), fill=INK, anchor="lm")
    # she pulls it from the left, walking left
    s = 5
    cx = note_x - 260
    a = MANIFEST["drag"]
    box = paste_sprite(img, "drag", t, s, cx, FLOOR, flip=False)
    rope_y = box[1] + a["rope"][int(t * a["fps"]) % a["frames"]] * s
    d.line([(box[0] + 4, rope_y), (note[0] + 10, note[1] + 70)], fill=INK, width=6) if False else None
    d.line([(box[2] - 4, rope_y), (note[0] + 6, note[1] + 70)], fill=INK, width=6)


def s_perch(img, t, L):
    caption(img, "她最喜欢坐在你的窗口上", "窗口一动，她就掉下来", t)
    win_y = 1060 if t < 3.0 else 1060 + 380 * ease((t - 3.0) / 0.5)
    w1 = window(img, (150, win_y, 930, win_y + 520), "周报.docx — Word", k=3)
    d = ImageDraw.Draw(img)
    for i in range(5):
        d.rounded_rectangle([w1[0] + 40, w1[1] + 50 + i * 64, w1[2] - 40 - (i % 3) * 110, w1[1] + 76 + i * 64], 6, fill=(225, 220, 214))
    desk(img)
    s = 5
    a = MANIFEST["sit"]
    if t < 0.9:  # hop up from the floor
        u = ease(t / 0.9)
        y = FLOOR - (FLOOR - 1060 - a["sink"] * s) * u - 220 * 4 * u * (1 - u)
        paste_sprite(img, "happy", t, s, 400 + 80 * u, y, shadow=False)
    elif t < 3.0:
        im = scaled(frame_at("sit", t), s)
        img.alpha_composite(im, (int(480 - im.width / 2), int(1060 - im.height + a["sink"] * s)))
        if t > 1.2:
            bubble(img, 600, 1060 - im.height + a["sink"] * s + 30, "这里视野真好！", k=K, width=420, size=42, tail_x=500)
    else:
        u = min(1, (t - 3.0) / 0.7)
        if u < 1:
            y = 1060 + (FLOOR - 1060) * u * u
            paste_sprite(img, "dangle", t, s, 480, y, shadow=False)
            bubble(img, 600, y - 640, "哇啊——！", k=K, width=320, size=44, tail_x=480)
        else:
            paste_sprite(img, "tumble", t - 3.7, s, 480, FLOOR, loop=False)


def s_growth(img, t, L):
    caption(img, "她会记住你，也会长大", "整理记忆 · 写日记 · 升级解锁", t)
    desk(img)
    d = ImageDraw.Draw(img)
    panel = (90, 470, 990, 1010)
    pixel_box(img, panel, fill=(255, 246, 232), k=3)
    x0, y0 = panel[0] + 40, panel[1] + 36
    xp = 0.35 + 0.65 * ease(t / 1.8)
    lv = 3 if xp >= 0.99 else 2
    d.text((x0, y0), f"Lv.{lv}", font=font(60, True), fill=ORANGE_D)
    d.rounded_rectangle([x0 + 190, y0 + 22, panel[2] - 50, y0 + 56], 8, outline=INK, width=4, fill=(255, 253, 249))
    d.rounded_rectangle([x0 + 196, y0 + 28, x0 + 196 + (panel[2] - 50 - x0 - 202) * (xp if lv == 2 else 0.1), y0 + 50], 5, fill=ORANGE)
    y = y0 + 110
    d.text((x0, y), "🌱 成长笔记", font=font(38, True), fill=INK)
    notes = ["主人专心写代码时，我要少说话。", "修 bug 先给结论，简短清楚。", "有截止的事，到点前轻声提醒。"]
    for i, n in enumerate(notes):
        if t > 0.6 + i * 0.5:
            d.text((x0, y + 70 + i * 62), "· " + n, font=font(34), fill=INK)
    if lv == 3:
        sign_text(img, t, 5, W / 2, FLOOR, "Lv.3!")
        bubble(img, W / 2 + 60, 1180, "我升级啦！学会了变魔术～", k=K, width=620, size=42, tail_x=W / 2)
    else:
        paste_sprite(img, "write", t, 5, W / 2, FLOOR)


def s_agenda(img, t, L):
    caption(img, "你不在时，她在帮你做事", "简报 · 巡检 · 每日小技巧", t)
    desk(img)
    if t < 1.4:
        paste_sprite(img, "nap", t, 6, W / 2, FLOOR)
        d = ImageDraw.Draw(img)
        d.text((W / 2 + 200, 1180), "z Z", font=font(60, True), fill=(80, 120, 200))
    else:
        paste_sprite(img, "wave", t, 5, W / 2 + 220, FLOOR)
        bubble(img, W / 2 - 60, 1240, "☀️ 今日简报\n周报 16:00 截止，现在动手正好～\n🔍 有 19 个改动还没提交\n☔ 晚点有雨，记得带伞",
               k=K, width=820, size=40, buttons=["好的"], max_chars=typed(None, t - 1.5, 40), tail_x=W / 2 + 200)


def s_cute(img, t, L):
    caption(img, "47 个动作，天天不重样", None, t)
    desk(img)
    seq = ["umbrella", "dance", "pet", "magic", "shy", "laugh", "gift", "dizzy"]
    labels = ["下雨撑伞", "听歌跳舞", "逗小猫", "变魔术", "被夸害羞", "大笑", "送你礼物", "被戳晕了"]
    per = L / len(seq)
    i = min(len(seq) - 1, int(t / per))
    lt = t - i * per
    pop = 1 + 0.12 * max(0.0, 1 - lt / 0.25)
    paste_sprite(img, seq[i], lt, 6 * pop, W / 2, FLOOR)
    d = ImageDraw.Draw(img)
    outlined(d, (W / 2, 470), labels[i], font(76, True), fill=(255, 196, 120), outline=INK, w=8)
    # small row of the other ones
    for j, n in enumerate(seq):
        x = 120 + j * 120
        fr = scaled(frame_at(n, t), 1)
        alpha = 255 if j == i else 110
        if alpha < 255:
            fr = fr.copy()
            fr.putalpha(fr.getchannel("A").point(lambda v: v * alpha // 255))
        img.alpha_composite(fr, (int(x - fr.width / 2), 700 - fr.height))


def s_outro(img, t, L):
    d = ImageDraw.Draw(img)
    sunflower(img, 120, 200, 50)
    sunflower(img, 960, 190, 38)
    outlined(d, (W / 2, 330), "Claude Ojousama", font(92, True), fill=CREAM, outline=INK, w=10)
    d.text((W / 2, 450), "会看屏幕 · 会主动帮忙 · 会长大的像素桌宠", font=font(40), fill=INK, anchor="mm")
    pixel_box(img, (110, 560, 970, 760), fill=(255, 252, 246), k=3)
    d.text((W / 2, 615), "⭐ 开源免费 · Windows", font=font(40, True), fill=ORANGE_D, anchor="mm")
    d.text((W / 2, 695), "github.com/Silasvanceneo/claude-ojousama", font=mono(36), fill=INK, anchor="mm")
    desk(img)
    paste_sprite(img, "cheer", t, 6, W / 2, FLOOR)
    if t > 0.5:
        bubble(img, W / 2 + 30, 1000, "带我回家吧～", k=K, width=460, size=48, tail_x=W / 2)


SCENES = [
    (s_intro, 4.0), (s_typing, 3.2), (s_error, 4.6), (s_fixed, 3.0), (s_remind, 4.4), (s_note, 3.4),
    (s_perch, 5.2), (s_growth, 4.2), (s_agenda, 5.2), (s_cute, 6.4), (s_outro, 4.0),
]


def render(t_global):
    acc = 0.0
    for fn, L in SCENES:
        if t_global < acc + L or fn is SCENES[-1][0]:
            t = t_global - acc
            img = BG.copy()
            fn(img, t, L)
            # quick fade between scenes
            fade = min(1.0, t / 0.18, max(0.0, (L - t) / 0.18)) if fn is not SCENES[-1][0] else min(1.0, t / 0.18)
            if fade < 1:
                img = Image.blend(Image.new("RGBA", (W, H), (255, 244, 228, 255)), img, fade)
            return img
        acc += L


TOTAL = sum(L for _, L in SCENES)


# ------------------------------------------------------------------ chiptune

def chiptune(path, seconds, sr=44100):
    """Cheerful square-wave loop (C - G - Am - F) with a little triangle bass and a hi-hat."""
    bpm = 132
    beat = 60 / bpm
    n = int(seconds * sr)
    out = np.zeros(n, dtype=np.float64)
    tt = np.arange(n) / sr

    def note(freq, start, dur, vol, kind="square"):
        a, b = int(start * sr), min(n, int((start + dur) * sr))
        if a >= n or b <= a:
            return
        x = tt[a:b] - start
        if kind == "square":
            w = np.sign(np.sin(2 * np.pi * freq * x)) * 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * freq * x)) * (np.sin(2 * np.pi * freq * x) > 0.4)
            w = np.sign(np.sin(2 * np.pi * freq * x))
        else:
            w = 2 * np.abs(2 * ((freq * x) % 1) - 1) - 1
        env = np.minimum(1, x / 0.005) * np.exp(-x * 3.2)
        out[a:b] += w * env * vol

    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]
    melody = [72, 76, 79, 76, 74, 71, 74, 79, 72, 76, 81, 79, 77, 76, 74, 72]
    bar = 4 * beat
    t0 = 0.0
    i = 0
    while t0 < seconds:
        ch = chords[i % 4]
        note(hz(ch[0] - 24), t0, beat * 1.9, 0.22, "tri")
        note(hz(ch[0] - 24), t0 + 2 * beat, beat * 1.9, 0.22, "tri")
        for k in range(8):  # arpeggio eighths
            note(hz(ch[k % 3] + 12), t0 + k * beat / 2, beat / 2 * 0.9, 0.035)
        for k in range(4):
            m = melody[(i * 4 + k) % len(melody)]
            note(hz(m), t0 + k * beat, beat * 0.85, 0.06)
        for k in range(8):  # hat
            a = int((t0 + k * beat / 2) * sr)
            b = min(n, a + int(0.03 * sr))
            if a < n:
                out[a:b] += np.random.RandomState(k + i).uniform(-1, 1, b - a) * np.linspace(0.05, 0, b - a)
        t0 += bar
        i += 1
    fade = int(1.5 * sr)
    out[-fade:] *= np.linspace(1, 0, fade)
    out[: int(0.05 * sr)] *= np.linspace(0, 1, int(0.05 * sr))
    out = np.clip(out / max(1e-9, np.abs(out).max()) * 0.7, -1, 1)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((out * 32767).astype(np.int16).tobytes())


def main():
    os.makedirs(OUT, exist_ok=True)
    if "--preview" in sys.argv:
        times = [float(x) for x in sys.argv[sys.argv.index("--preview") + 1:]] or [3.5, 9, 11.5, 18, 26]
        for tm in times:
            render(tm).convert("RGB").save(os.path.join(ROOT_DEV, f"vid_{tm:05.1f}.png"))
        print("preview", times, "total", TOTAL)
        return
    wav = os.path.join(OUT, "_bgm.wav")
    chiptune(wav, TOTAL)
    mp4 = os.path.join(OUT, "claude-ojousama-promo.mp4")
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", wav, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
           "-shortest", "-movflags", "+faststart", mp4]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    frames_n = int(TOTAL * FPS)
    for f in range(frames_n):
        p.stdin.write(render(f / FPS).convert("RGB").tobytes())
        if f % 150 == 0:
            print(f"{f}/{frames_n}", flush=True)
    p.stdin.close()
    p.wait()
    os.remove(wav)
    print("done", mp4, TOTAL, "s")


ROOT_DEV = os.path.join(os.path.dirname(OUT), ".dev")

if __name__ == "__main__":
    main()
