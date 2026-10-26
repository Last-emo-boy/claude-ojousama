"""Promo cards (1080x1440, 3:4) for a social post. Output: promo/cards/01..08.png

Usage: python tools/promo/cards.py
"""
import os

from PIL import Image, ImageDraw

from common import (CODE_BG, CREAM, GREEN, INK, MANIFEST, MUTED, ORANGE, ORANGE_D, OUT, PAPER, RED, SUN,
                    bubble, button, chip, font, frame_at, mono, outlined, paste_sprite, pixel_box, scaled,
                    sign_text, sunflower, taskbar, text_block, wallpaper, window)

W, H = 1080, 1440
K = 3
DIR = os.path.join(OUT, "cards")


def base(title, sub, n):
    img = wallpaper(W, H)
    d = ImageDraw.Draw(img)
    outlined(d, (W / 2, 104), title, font(66, True), fill=CREAM, outline=INK, w=7)
    if sub:
        d.text((W / 2, 184), sub, font=font(34), fill=INK, anchor="mm")
    # footer
    d.text((48, H - 52), "Claude Ojousama · 像素 AI 桌面伙伴", font=font(24), fill=MUTED, anchor="lm")
    d.text((W - 48, H - 52), f"{n}/8", font=font(24, True), fill=ORANGE_D, anchor="rm")
    return img, d


def save(img, n):
    os.makedirs(DIR, exist_ok=True)
    p = os.path.join(DIR, f"{n:02d}.png")
    img.convert("RGB").save(p, optimize=True)
    return p


def code_lines(d, box, lines, size=26, start=1):
    x0, y0, x1, _ = box
    f = mono(size)
    for i, (txt, col) in enumerate(lines):
        y = y0 + 18 + i * size * 1.45
        d.text((x0 + 16, y), f"{start + i:>2}", font=f, fill=(110, 100, 90))
        d.text((x0 + 70, y), txt, font=f, fill=col)


# ------------------------------------------------------------------ 1 cover

def card_cover():
    img = wallpaper(W, H, top=(255, 214, 168), bottom=(255, 242, 222))
    d = ImageDraw.Draw(img)
    sunflower(img, 120, 150, 54)
    sunflower(img, 960, 260, 40)
    sunflower(img, 90, 1130, 34)
    outlined(d, (W / 2, 150), "我的桌面", font(92, True), fill=CREAM, outline=INK, w=9)
    outlined(d, (W / 2, 262), "住进了一位大小姐", font(92, True), fill=(255, 196, 120), outline=INK, w=9)
    d.text((W / 2, 356), "Claude Ojousama · 会看屏幕、会主动帮忙、会长大的像素桌宠", font=font(32), fill=INK, anchor="mm")
    # hero sprite
    paste_sprite(img, "wave", 0.25, 5, W / 2, 1160)
    bubble(img, W / 2 + 60, 560, "你好呀～今天也一起加油吧！", k=K, width=560, size=38, tail_x=W / 2 + 10)
    # little friends
    paste_sprite(img, "typing", 0.3, 3, 190, 1180)
    paste_sprite(img, "umbrella", 0.6, 3, 890, 1180)
    taskbar(img, 1240, 70, k=3)
    x = 60
    for lab in ["👀 看屏幕", "⏰ 追着提醒", "🪟 坐窗口", "🌱 会成长", "🎬 47 个动作"]:
        x = chip(img, (x, 1340), lab, k=3, size=27) + 12
    return save(img, 1)


# ------------------------------------------------------------------ 2 screen rescue

def card_screen():
    img, d = base("她真的会看你的屏幕", "报错一出来，她就拿着放大镜过来了", 2)
    box = window(img, (60, 250, 1020, 800), "main.py — VS Code", k=3, dark=True)
    code_lines(d, box, [
        ("def load_users(path):", (156, 220, 254)),
        ("    with open(path) as f:", (220, 220, 220)),
        ("        rows = json.load(f)", (220, 220, 220)),
        ("    return [User(**r) for r in rows", (220, 220, 220)),
        ("", (0, 0, 0)),
        ("users = load_users('users.json')", (220, 220, 220)),
        ("", (0, 0, 0)),
        ("$ python main.py", (157, 255, 157)),
        ("  File \"main.py\", line 4", (255, 140, 120)),
        ("    return [User(**r) for r in rows", (255, 140, 120)),
        ("SyntaxError: '[' was never closed", (255, 110, 90)),
    ], size=25)
    d.rectangle([box[0] + 64, box[1] + 18 + 3 * 25 * 1.45 - 4, box[2] - 20, box[1] + 18 + 4 * 25 * 1.45 - 6], outline=(255, 110, 90), width=3)
    paste_sprite(img, "magnify", 0.4, 4, 250, 1350)
    bubble(img, 640, 1010, "第 4 行的列表推导式少了个 ] 呀～要我帮你补上吗？", k=K, width=680, buttons=["好呀", "不用"], size=34, tail_x=430)
    d.text((520, 1090), "· 报错、切换窗口时看一眼\n· 密码、网银、聊天窗口从不截图\n· 截图用完立即删除", font=font(30), fill=INK, spacing=16)
    return save(img, 2)


# ------------------------------------------------------------------ 3 reminders

def card_remind():
    img, d = base("说好的事，她不会让你忘", "提醒没理？她会敲敲屏幕再来", 3)
    # escalation strip
    steps = [("wave", "16:00 交周报啦～", "第 1 次"), ("squish", "还没回我呢…", "第 2 次 · 敲屏幕"), ("angry", "最后提醒一次！", "第 3 次 · 大力敲")]
    for i, (anim, txt, cap) in enumerate(steps):
        cx = 190 + i * 350
        pixel_box(img, (cx - 160, 230, cx + 160, 820), fill=(255, 252, 246), k=3)
        paste_sprite(img, anim, 0.3, 3, cx, 760, shadow=False)
        bubble(img, cx, 380, txt, k=3, width=290, size=28)
        d.text((cx, 788), cap, font=font(26, True), fill=ORANGE_D, anchor="mm")
    # sticky note being dragged
    note = (560, 880, 980, 1290)
    pixel_box(img, note, fill=(255, 236, 150), k=3)
    d.text((note[0] + 30, note[1] + 26), "📌 今天要做", font=font(34, True), fill=INK)
    items = [("提交周报", True), ("修复登录 bug", False), ("给小猫买猫粮", False), ("18:30 写今日小结", False)]
    for i, (t, done) in enumerate(items):
        y = note[1] + 100 + i * 66
        d.rectangle([note[0] + 34, y, note[0] + 66, y + 32], outline=INK, width=3, fill=(255, 250, 230))
        if done:
            d.line([(note[0] + 38, y + 16), (note[0] + 48, y + 28), (note[0] + 64, y + 4)], fill=GREEN, width=5)
        d.text((note[0] + 84, y + 16), t, font=font(32), fill=MUTED if done else INK, anchor="lm")
        if done:
            d.line([(note[0] + 84, y + 18), (note[0] + 84 + d.textlength(t, font=font(32)), y + 18)], fill=MUTED, width=3)
    # she pulls it along with a rope (flipped: the rope leaves her right edge)
    s, t = 3, 0.2
    drag = paste_sprite(img, "drag", t, s, 300, 1300, flip=True)
    a = MANIFEST["drag"]
    rope_y = drag[1] + a["rope"][int(t * a["fps"]) % a["frames"]] * s
    d.line([(drag[2] - 2, rope_y), (note[0] + 6, note[1] + 70)], fill=INK, width=5)
    d.text((60, 870), "她把待办写成便签\n亲手拖到桌面贴好", font=font(36, True), fill=INK, spacing=14)
    return save(img, 3)


# ------------------------------------------------------------------ 4 windows

def card_windows():
    img, d = base("她最喜欢坐在你的窗口上", "晃着腿看你工作，窗口一动就掉下来", 4)
    d.text((70, 236), "· 自动找没被挡住的窗口边\n· 沿着窗口边散步，跳到别的窗口\n· 拖到窗口上方松手，她会坐好", font=font(32), fill=INK, spacing=14)
    w1 = window(img, (70, 780, 760, 1215), "周报.docx — Word", k=3)
    for i in range(5):
        d.rounded_rectangle([w1[0] + 40, w1[1] + 50 + i * 60, w1[2] - 40 - (i % 3) * 90, w1[1] + 74 + i * 60], 6, fill=(225, 220, 214))
    w2 = window(img, (620, 560, 1010, 860), "音乐", k=3)
    d.rounded_rectangle([w2[0] + 30, w2[1] + 30, w2[0] + 160, w2[1] + 160], 12, fill=(255, 180, 120))
    d.text((w2[0] + 185, w2[1] + 60), "晴天", font=font(36, True), fill=INK)
    d.text((w2[0] + 185, w2[1] + 110), "周杰伦", font=font(28), fill=MUTED)
    # she sits on the Word window's top edge
    a = MANIFEST["sit"]
    s = 3
    sit = scaled(frame_at("sit", 0.2), s)
    top = 780
    sx, sy = 170, int(top - sit.height + a["sink"] * s)
    img.alpha_composite(sit, (sx, sy))
    bubble(img, sx + sit.width / 2 + 40, sy + 20, "这里视野真好！", k=3, width=300, size=32, tail_x=sx + sit.width / 2)
    # dotted hop arc over to the music window
    p0, p1 = (sx + sit.width - 20, sy + 120), (w2[0] + 120, 560 - 40)
    for i in range(10):
        u = i / 9
        x = p0[0] + (p1[0] - p0[0]) * u
        y = p0[1] + (p1[1] - p0[1]) * u - 160 * 4 * u * (1 - u)
        d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=ORANGE, outline=INK, width=2)
    taskbar(img, 1240, 66, k=3)
    return save(img, 4)


# ------------------------------------------------------------------ 5 growth

def card_growth():
    img, d = base("她会记住你，也会长大", "整理记忆、写成长笔记、写日记", 5)
    panel = (60, 250, 700, 1320)
    pixel_box(img, panel, fill=PAPER, k=3)
    x0, y0 = panel[0] + 34, panel[1] + 30
    d.text((x0, y0), "Lv.3", font=font(48, True), fill=ORANGE_D)
    d.rounded_rectangle([x0 + 140, y0 + 18, panel[2] - 40, y0 + 46], 6, outline=INK, width=4, fill=(255, 253, 249))
    d.rounded_rectangle([x0 + 144, y0 + 22, x0 + 144 + 260, y0 + 42], 4, fill=ORANGE)
    y = y0 + 90
    x = x0
    for lab, ok in [("✓ 小猫串门", True), ("✓ 变魔术", True), ("🔒 跳舞", False)]:
        x = chip(img, (x, y), lab, k=3, size=26, fill=(255, 226, 194) if ok else (245, 238, 228)) + 10
    y += 90
    d.text((x0, y), "她学到的", font=font(34, True), fill=INK)
    y += 56
    for label, stat, trend, col in [("报错救援", "接受 3 · 拒绝 0", "↑ 会更常这样做", ORANGE_D), ("复制提示", "接受 0 · 拒绝 2", "↓ 以后少打扰", (180, 90, 60))]:
        d.text((x0, y), label, font=font(30), fill=INK)
        d.text((x0 + 170, y + 4), stat, font=font(24), fill=MUTED)
        d.text((panel[2] - 40, y + 4), trend, font=font(24), fill=col, anchor="ra")
        y += 54
    y += 20
    d.text((x0, y), "成长笔记", font=font(34, True), fill=INK)
    y += 56
    for n in ["主人专心写代码时，我吐槽要少，半小时一两次就够。", "帮主人修 bug 时，先给结论和改法，简短清楚最好。", "有截止的事，到点前直接轻声提醒。"]:
        y = text_block(d, (x0, y), "🌱 " + n, font(27), width=panel[2] - x0 - 40, spacing=1.35) + 12
    y += 10
    d.text((x0, y), "日记 · 10-25", font=font(34, True), fill=INK)
    y += 56
    text_block(d, (x0, y), "周日的主人也好忙！一直在给我加跳舞和变魔术，本大小姐超开心～主人 4 点前要交周报，我会安静守着，记得提醒喝水！", font(27), fill=(90, 70, 58), width=panel[2] - x0 - 40)
    sign_text(img, 0.4, 3, 885, 760, "Lv.3!")
    d.text((885, 800), "升级会解锁新本事", font=font(28, True), fill=INK, anchor="mm")
    paste_sprite(img, "pet", 0.5, 3, 885, 1220)
    d.text((885, 1255), "Lv.2 · 小猫来串门", font=font(26), fill=MUTED, anchor="mm")
    return save(img, 5)


# ------------------------------------------------------------------ 6 background work

def card_agenda():
    img, d = base("你不在时，她在帮你做事", "她自己开 DeepSeek Harness 后台任务", 6)
    items = [
        ("☀️ 今日简报", "今天最要紧的是周报，16:00 截止，还剩一个半小时，这会儿动手正好～上海晚点有雨，出门记得带伞。", "wave"),
        ("🔍 工作区巡检", "claude-ojousama 有 19 个改动还没提交，新文件也没 git add，要我帮你记成待办吗？", "magnify"),
        ("💡 每日小技巧", "改名前先跑 git grep -in 旧名，改完再跑一遍，确认一个都没剩～", "point"),
    ]
    y = 250
    for title, body, anim in items:
        box = (60, y, 1020, y + 300)
        pixel_box(img, box, fill=(255, 252, 246), k=3)
        paste_sprite(img, anim, 0.3, 2, 170, y + 280, shadow=False)
        d.text((290, y + 34), title, font=font(38, True), fill=ORANGE_D)
        text_block(d, (290, y + 96), body, font(29), width=690)
        y += 330
    pixel_box(img, (60, 1250, 1020, 1350), fill=(236, 248, 236), k=3)
    d.text((540, 1300), "🔒 后台任务只读：没有命令行、不联网、不改文件", font=font(32, True), fill=(40, 100, 50), anchor="mm")
    return save(img, 6)


# ------------------------------------------------------------------ 7 gallery

def card_gallery():
    img, d = base("47 个动作，每天都有新表情", "睡觉 · 撑伞 · 害羞 · 跳舞 · 变魔术 · 逗猫…", 7)
    names = ["wave", "typing", "magnify", "nap", "umbrella", "shy", "laugh", "dizzy", "angry", "thumbsup", "gift", "dance",
             "magic", "pet", "relax", "phone", "clean", "write", "run", "squish"]
    labels = {"wave": "挥手", "typing": "敲代码", "magnify": "放大镜", "nap": "睡觉", "umbrella": "撑伞", "shy": "害羞", "laugh": "大笑",
              "dizzy": "晕乎乎", "angry": "生气", "thumbsup": "点赞", "gift": "送礼", "dance": "跳舞", "magic": "变魔术", "pet": "逗猫",
              "relax": "躺沙发", "phone": "玩手机", "clean": "打扫", "write": "写日记", "run": "跑步", "squish": "贴屏幕"}
    cols, cw, ch = 5, 206, 272
    x0, y0 = (W - cols * cw) / 2, 236
    for i, n in enumerate(names):
        cx = x0 + (i % cols) * cw + cw / 2
        top = y0 + (i // cols) * ch
        d.rounded_rectangle([cx - cw / 2 + 5, top + 5, cx + cw / 2 - 5, top + ch - 5], 18, fill=(255, 252, 246, 255), outline=(230, 205, 175), width=3)
        paste_sprite(img, n, 0.3, min(2, (ch - 64) / MANIFEST[n]["h"]), cx, top + ch - 46, shadow=False)
        d.text((cx, top + ch - 26), labels[n], font=font(26, True), fill=INK, anchor="mm")
    return save(img, 7)


# ------------------------------------------------------------------ 8 install

def card_install():
    img, d = base("开源免费，装上就能用", "Windows 10/11 · 内核 DeepSeek Harness", 8)
    term = window(img, (60, 260, 1020, 700), "PowerShell", k=3, dark=True)
    f = mono(30)
    lines = [("> git clone https://github.com/", (157, 255, 157)), ("    Silasvanceneo/claude-ojousama", (157, 255, 157)), ("> cd claude-ojousama", (220, 220, 220)),
             ("> npm install", (220, 220, 220)), ("> npm run install-app", (220, 220, 220)), ("Claude Ojousama 启动啦～", (255, 200, 120))]
    for i, (t, c) in enumerate(lines):
        d.text((term[0] + 30, term[1] + 30 + i * 52), t, font=f if i < 5 else font(30), fill=c)
    y = 760
    for t in ["沿用你在 DeepSeek Harness 里配置的模型", "每种主动行为都能设：自动 / 先问我 / 禁止", "记忆、日记只存在本机", "MIT 开源 · 粉丝向个人项目"]:
        d.text((80, y), "✅ " + t, font=font(32), fill=INK)
        y += 64
    paste_sprite(img, "thumbsup", 0.3, 3, 905, 1330)
    pixel_box(img, (60, 1150, 740, 1300), fill=(255, 252, 246), k=3)
    d.text((90, 1185), "⭐ GitHub", font=font(30, True), fill=ORANGE_D)
    d.text((90, 1235), "Silasvanceneo/claude-ojousama", font=mono(32), fill=INK)
    return save(img, 8)


if __name__ == "__main__":
    for fn in [card_cover, card_screen, card_remind, card_windows, card_growth, card_agenda, card_gallery, card_install]:
        print(fn())
