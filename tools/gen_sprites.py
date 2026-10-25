"""Generate raw sprite sheets for Claude Ojousama via an OpenAI-compatible image edit API.

Usage: set PET_IMG_BASE (API base URL), PET_IMG_KEY and optionally PET_IMG_MODEL, then
    python tools/gen_sprites.py [name ...]
Raw sheets land in assets/raw/<name>.png, then run tools/process_sprites.py --add <name ...>.
The endpoint and key are read from the environment only and never written to disk.
"""
import base64
import concurrent.futures as cf
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
REF = os.path.join(ROOT, "assets", "reference", "base.png")
BASE_URL = os.environ.get("PET_IMG_BASE", "").rstrip("/")
MODEL = os.environ.get("PET_IMG_MODEL", "gpt-image-2.5-flare")

STYLE = (
    "Same character as the reference image with an identical design: long flowing orange hair, orange sunflower "
    "hair ornament with a dark brown ribbon and tassels, amber eyes, oversized beige knit cardigan, cream top, "
    "dark brown pleated skirt, white socks, brown loafers. Same chibi proportions and the same 16-bit pixel art "
    "style: crisp hard pixel edges, limited palette, dark 1px outline, no anti-aliasing. "
    "Plain flat pure white background, no ground shadow, no frame borders, no text, no watermark. "
)
SHEET = (
    "Layout: a horizontal sprite sheet with exactly 4 animation frames in a single row, evenly spaced with wide "
    "empty white gaps between frames, every frame the same size and scale, character at the same position in each "
    "frame so the frames loop smoothly. "
)
DESK = (
    "She sits on a small red-cushioned wooden stool at a tiny wooden desk with drawers and a beige mini CRT "
    "computer, keyboard and mouse, exactly like the reference, side 3/4 view facing right. "
)

JOBS = {
    "typing": SHEET + DESK + "Animation: typing fast on the keyboard, hands alternating up and down, green code lines on the CRT screen scroll between frames.",
    "idle": SHEET + DESK + "Animation: relaxed idle, she holds a small coffee mug and sips it, frame 3 she blinks with closed eyes, gentle breathing motion.",
    "thinking": SHEET + DESK + "Animation: thinking, she turns slightly toward the viewer with one hand on her chin, looking up, three small white thought dots appear one by one above her head.",
    "sleep": SHEET + DESK + "Animation: asleep with her head resting on folded arms on the desk, small blue 'z' letters float up and grow, a tiny snot bubble inflates and pops.",
    "error": SHEET + DESK + "Animation: panic, the CRT screen shows a red X and grey smoke puffs rise from the monitor, she holds her cheeks with both hands, flustered sweat drop.",
    "happy": SHEET + "Standing full body facing the viewer, no desk. Animation: cheering and jumping with both arms raised, closed happy eyes, yellow sparkle stars pop around her.",
    "wave": SHEET + "Standing full body facing the viewer, no desk. Animation: smiling and waving one hand hello, hair swaying slightly.",
    "walk": SHEET + "Standing full body, side view facing right, no desk. Animation: a 4-frame walking cycle to the right, legs and arms swinging, hair bouncing.",
    "drag": SHEET + "Standing full body, side view facing right, no desk. Animation: walking to the right while leaning forward with effort, pulling a thick brown rope over her right shoulder with both hands; the rope trails behind her and runs off the LEFT edge of each frame at knee height. Determined face, little sweat drop.",
    "dangle": SHEET + "Full body facing the viewer, no desk, she is being lifted into the air by the back of her cardigan collar (no hand visible), legs dangling and kicking, arms flailing, flustered blushing face with swirly eyes.",
    "peek": SHEET + "Only her head and two hands peeking in from the RIGHT edge of each frame, the rest of her body is hidden off-frame to the right. Animation: she slides in to peek with a mischievous grin, frame 3 sticks her tongue out, frame 4 winks.",
    "surprise": SHEET + "Standing full body facing the viewer, no desk. Animation: startled jump, wide eyes, a yellow exclamation mark pops above her head, then she laughs.",
}

STAND = "Standing full body facing the viewer, no desk. "

# Second batch: more actions for screen reading, autonomy and moods.
JOBS.update({
    "look": SHEET + DESK + "Animation: she leans forward close to the CRT screen and stares at it intently with wide sparkling curious eyes, slight head tilt between frames, a tiny sparkle near her eyes, the screen glow lights her face.",
    "magnify": SHEET + STAND + "Animation: she holds a large round magnifying glass up to one eye so that eye looks huge through the lens, leaning forward to inspect something, bobbing slightly between frames, curious detective face.",
    "stretch": SHEET + STAND + "Animation: a big satisfying stretch with both arms raised high above her head and fingers interlaced, eyes closed, relaxed face, body leaning gently left and right between frames.",
    "water": SHEET + STAND + "Animation: drinking from a small light-blue water bottle, tilting her head back to drink, then lowering it with a refreshed smile, a tiny water sparkle.",
    "read": SHEET + DESK + "Animation: instead of using the computer she reads an open book held in both hands, eyes moving across the page, frame 3 she turns a page, calm happy face.",
    "eat": SHEET + STAND + "Animation: munching a round chocolate-chip cookie held in both hands, cheeks puffed, happy closed eyes, tiny crumbs falling.",
    "giggle": SHEET + STAND + "Animation: giggling mischievously with one hand covering her mouth, eyes squinted into smug arcs, shoulders shaking slightly between frames.",
    "point": SHEET + "Standing full body, side 3/4 view facing right, no desk. Animation: pointing to the right with her right index finger fully extended and the other hand on her hip, confident 'look over there!' face, the pointing arm bobs slightly between frames.",
    "sit": SHEET + "Full body front view, she sits on an invisible ledge at hip height, hands resting on the ledge beside her hips, legs hanging down freely below the seat. Animation: legs swinging back and forth alternately, relaxed happy face, hair swaying. Nothing is drawn under her except her dangling legs.",
    "yawn": SHEET + DESK + "Animation: a big sleepy yawn at the desk, one hand covering her wide open mouth, eyes squeezed shut with a tiny tear, the other arm stretching up.",
    "sulk": SHEET + STAND + "Animation: sulking and pouting with puffed-up cheeks and arms crossed, looking away, a small red anger mark near her head, a little foot stomp between frames.",
    "cheer": SHEET + STAND + "Animation: an encouraging 'you can do it!' pose, pumping one fist in the air with determined sparkling eyes, small orange energy sparks around the fist.",
    "shush": SHEET + STAND + "Animation: a quiet 'shh' gesture, index finger pressed to her lips while winking, the other hand waving gently, soft calm expression.",
    "music": SHEET + STAND + "Animation: wearing big orange over-ear headphones, eyes closed, bobbing her head and swaying to music, small musical notes floating up.",
    "cry": SHEET + STAND + "Animation: sad and teary, big watery eyes, small tears flying, wiping her eyes with her cardigan sleeve, trembling lips.",
})

# Third batch: daily life, emotions, social and special moves.
JOBS.update({
    "nap": SHEET + "Full body, no desk. She lies curled up on her side on a small round cream cushion, wearing a floppy striped nightcap with a pom-pom, hugging a little pillow, eyes closed, sleeping peacefully. Animation: gentle breathing, small blue 'z' letters float up and grow.",
    "phone": SHEET + STAND + "Animation: looking down at a smartphone held in both hands, thumb swiping the softly glowing screen; frame 3 she smiles at something funny, frame 4 raised eyebrows in surprise.",
    "clean": SHEET + STAND + "Animation: wearing a white cleaning bandana tied over her hair, she sweeps the floor with a small broom, little grey dust clouds puff up, busy determined face.",
    "umbrella": SHEET + STAND + "Animation: holding a small clear umbrella with little sunflower prints over her head, light blue raindrops fall around the umbrella, she twirls it slightly between frames, cheerful face.",
    "write": SHEET + DESK + "Animation: instead of the computer she writes in an open notebook with a pencil; frames 1-2 writing fast with small motion lines, frame 3 biting the pencil tip while thinking, frame 4 a tiny yellow light bulb sparkle above her head.",
    "relax": SHEET + "Full body, no desk. She lounges lazily on a squishy orange beanbag chair, a bag of chips in one hand and a soda can in the other, legs crossed, relaxed happy face. Animation: munching and sipping between frames.",
    "confused": SHEET + STAND + "Animation: confused, head tilted to one side, one hand scratching her cheek, a big yellow question mark pops above her head, puzzled eyes.",
    "shy": SHEET + STAND + "Animation: shy and embarrassed, cheeks blushing deep pink, both hands covering her face, then peeking through her fingers, then poking her index fingers together while looking away.",
    "dizzy": SHEET + STAND + "Animation: dizzy, eyes turned into spiral swirls, body swaying left and right on wobbly legs, small yellow stars circling around her head.",
    "angry": SHEET + STAND + "Animation: angry, hands on hips, stomping one foot, puffed red cheeks, a small cartoon flame puffing from her mouth as she shouts, a red anger mark near her head.",
    "laugh": SHEET + STAND + "Animation: laughing hard, holding her belly with both arms, eyes squeezed shut with tears of laughter at the corners, mouth wide open, body bouncing with big motion.",
    "thumbsup": SHEET + STAND + "Animation: a big confident thumbs up toward the viewer with one hand, frame 3 with both hands, winking, yellow sparkles and small stars pop around her hands.",
    "sign": SHEET + STAND + "She holds up a large blank light-wood rectangular sign board in front of her chest with both hands. The board is completely empty: no text, no symbols, a clean flat light beige wooden surface with a thin darker wood border. The board stays at exactly the same place and size in every frame; only her face changes (smile, blink, wink).",
    "gift": SHEET + STAND + "Animation: presenting a present with both hands stretched forward: a small box wrapped in orange paper with a cream ribbon bow and a single sunflower tucked into the ribbon; gentle hopeful smile, small sparkles around the gift.",
    "squish": SHEET + "Close-up of only her head, shoulders and both hands: her face and palms are pressed flat against the inside of a glass screen as if squished against the viewer's monitor; cheeks and nose squished flat, funny wide eyes, palms flattened. Animation: the squish pulses slightly between frames.",
    "run": SHEET + "Standing full body, side view facing right, no desk. Animation: a 4-frame energetic running cycle to the right, long orange hair and skirt fluttering behind her, arms pumping, determined happy face.",
    "tumble": SHEET + "Full body, no desk. Animation: frame 1 tripping forward with arms flailing, frame 2 face-planted flat on the ground with arms stretched out, frame 3 sitting up on the ground rubbing her knee with teary eyes, frame 4 still sitting and rubbing her head with an embarrassed smile.",
    "dance": SHEET + STAND + "Animation: a cute idol dance: frame 1 a light step to the left with one hand pointing up, frame 2 a spin with skirt and hair flaring, frame 3 a step to the right with a wink and a peace sign, frame 4 a little hop, small musical sparkles.",
    "pet": SHEET + "Full body, side 3/4 view facing right, no desk. Animation: she crouches down and gently pets a small fluffy white kitten sitting in front of her; the kitten leans into her hand and purrs, tiny pink hearts float up, soft gentle smile.",
    "magic": SHEET + STAND + "Animation: casting a cute spell, waving a small star-tipped magic wand in an arc, a trail of sparkles and small sunflower petals swirls from the wand tip, happy confident face, hair floating slightly.",
})


def generate(name: str, prompt: str, key: str) -> str:
    out = os.path.join(RAW, f"{name}.png")
    full = STYLE + prompt
    t = time.time()
    for attempt in range(3):
        try:
            with open(REF, "rb") as f:
                r = requests.post(
                    f"{BASE_URL}/v1/images/edits",
                    headers={"Authorization": "Bearer " + key},
                    files={"image": ("base.png", f, "image/png")},
                    data={"model": MODEL, "prompt": full, "size": "1536x1024", "n": "1"},
                    timeout=400,
                )
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
            d = r.json()["data"][0]
            data = base64.b64decode(d["b64_json"]) if d.get("b64_json") else requests.get(d["url"], timeout=120).content
            with open(out, "wb") as fh:
                fh.write(data)
            return f"{name}: ok in {time.time() - t:.0f}s"
        except Exception as e:  # noqa: BLE001 - report and retry
            err = e
            time.sleep(3)
    return f"{name}: FAILED {err}"


def main() -> None:
    key = os.environ.get("PET_IMG_KEY")
    if not key or not BASE_URL:
        sys.exit("set PET_IMG_BASE (OpenAI-compatible API base URL) and PET_IMG_KEY first")
    os.makedirs(RAW, exist_ok=True)
    names = sys.argv[1:] or list(JOBS)
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for msg in ex.map(lambda n: generate(n, JOBS[n], key), names):
            print(msg, flush=True)


if __name__ == "__main__":
    main()
