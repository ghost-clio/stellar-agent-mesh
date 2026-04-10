#!/bin/bash
# Generate demo video for Stellar Agent Mesh — DoraHacks submission
# Uses ffmpeg to create a scrolling dashboard video with text overlays

set -e
cd "$(dirname "$0")"

# Output
OUT="/tmp/stellar-mesh-demo"
mkdir -p "$OUT"

# Duration and resolution
W=1920
H=1080
DURATION=45
FPS=30

# Colors
BG="#0a0a0a"
TEXT="#e0e0e0"
ACCENT="#3b82f6"
GREEN="#22c55e"

# Create title card
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=6" \
  -vf "\
    drawtext=text='Stellar Agent Mesh':fontsize=72:fontcolor=white:x=(w-tw)/2:y=h/2-120:enable='gte(t,0.5)',\
    drawtext=text='Agent-to-Agent Economic Infrastructure on Stellar':fontsize=28:fontcolor=0x707070:x=(w-tw)/2:y=h/2-30:enable='gte(t,1)',\
    drawtext=text='4 AI Agents • 954 Transactions • 99.4%% Success':fontsize=24:fontcolor=0x3b82f6:x=(w-tw)/2:y=h/2+30:enable='gte(t,1.5)',\
    drawtext=text='x402 + MPP Dual Protocol • Federation • Spending Governance':fontsize=22:fontcolor=0x707070:x=(w-tw)/2:y=h/2+70:enable='gte(t,2)',\
    drawtext=text='Built by ghost-clio':fontsize=20:fontcolor=0x404040:x=(w-tw)/2:y=h/2+140:enable='gte(t,2.5)'\
  " -t 6 -c:v libx264 -pix_fmt yuv420p "$OUT/01-title.mp4"

# Problem slide
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=5" \
  -vf "\
    drawtext=text='The Problem':fontsize=56:fontcolor=0xef4444:x=(w-tw)/2:y=200:enable='gte(t,0.3)',\
    drawtext=text='AI agents need to pay each other for services.':fontsize=30:fontcolor=white:x=(w-tw)/2:y=340:enable='gte(t,0.8)',\
    drawtext=text='Current solutions build payment clients OR servers.':fontsize=26:fontcolor=0x707070:x=(w-tw)/2:y=400:enable='gte(t,1.3)',\
    drawtext=text='Nobody builds the MESH.':fontsize=36:fontcolor=0x3b82f6:x=(w-tw)/2:y=480:enable='gte(t,2)',\
    drawtext=text='Discovery • Governance • Identity • Funding • Audit':fontsize=24:fontcolor=0x707070:x=(w-tw)/2:y=560:enable='gte(t,2.5)'\
  " -t 5 -c:v libx264 -pix_fmt yuv420p "$OUT/02-problem.mp4"

# Solution slide
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=6" \
  -vf "\
    drawtext=text='The Solution':fontsize=56:fontcolor=0x22c55e:x=(w-tw)/2:y=150:enable='gte(t,0.3)',\
    drawtext=text='One gateway. Any agent framework. Real Stellar rails.':fontsize=28:fontcolor=white:x=(w-tw)/2:y=280:enable='gte(t,0.8)',\
    drawtext=text='x402 Micropayments':fontsize=24:fontcolor=0x3b82f6:x=200:y=380:enable='gte(t,1.3)',\
    drawtext=text='MPP Sessions':fontsize=24:fontcolor=0x3b82f6:x=200:y=430:enable='gte(t,1.6)',\
    drawtext=text='Federation Identity (SEP-2)':fontsize=24:fontcolor=0x3b82f6:x=200:y=480:enable='gte(t,1.9)',\
    drawtext=text='Spending Governance':fontsize=24:fontcolor=0x3b82f6:x=200:y=530:enable='gte(t,2.2)',\
    drawtext=text='Fleet Admin (RBAC)':fontsize=24:fontcolor=0x3b82f6:x=200:y=580:enable='gte(t,2.5)',\
    drawtext=text='Fiat On-Ramp (SEP-24)':fontsize=24:fontcolor=0x3b82f6:x=1000:y=380:enable='gte(t,1.3)',\
    drawtext=text='Blocklist + Spend Alerts':fontsize=24:fontcolor=0x3b82f6:x=1000:y=430:enable='gte(t,1.6)',\
    drawtext=text='CSV Audit Export':fontsize=24:fontcolor=0x3b82f6:x=1000:y=480:enable='gte(t,1.9)',\
    drawtext=text='Escrow + Claimable Balances':fontsize=24:fontcolor=0x3b82f6:x=1000:y=530:enable='gte(t,2.2)',\
    drawtext=text='Path Payments (Auto FX)':fontsize=24:fontcolor=0x3b82f6:x=1000:y=580:enable='gte(t,2.5)',\
    drawtext=text='Settles in under 5 seconds on Stellar Testnet':fontsize=22:fontcolor=0xf59e0b:x=(w-tw)/2:y=700:enable='gte(t,3)'\
  " -t 6 -c:v libx264 -pix_fmt yuv420p "$OUT/03-solution.mp4"

# Architecture slide
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=5" \
  -vf "\
    drawtext=text='Architecture':fontsize=56:fontcolor=0xf59e0b:x=(w-tw)/2:y=100:enable='gte(t,0.3)',\
    drawtext=text='SOROBAN REGISTRY CONTRACT':fontsize=22:fontcolor=0x22c55e:x=(w-tw)/2:y=250:enable='gte(t,0.8)',\
    drawtext=text='Service listings • Reliability • Spending rules':fontsize=18:fontcolor=0x707070:x=(w-tw)/2:y=290:enable='gte(t,1)',\
    drawtext=text='|':fontsize=40:fontcolor=0x404040:x=w/2-5:y=320:enable='gte(t,1.2)',\
    drawtext=text='EXPRESS GATEWAY':fontsize=22:fontcolor=0x3b82f6:x=400:y=400:enable='gte(t,1.5)',\
    drawtext=text='x402 + MPP • Federation • Governance':fontsize=18:fontcolor=0x707070:x=400:y=440:enable='gte(t,1.7)',\
    drawtext=text='OPENCLAW SKILL':fontsize=22:fontcolor=0x3b82f6:x=1100:y=400:enable='gte(t,1.5)',\
    drawtext=text='Any agent becomes economic actor':fontsize=18:fontcolor=0x707070:x=1100:y=440:enable='gte(t,1.7)',\
    drawtext=text='|':fontsize=40:fontcolor=0x404040:x=w/2-5:y=480:enable='gte(t,2)',\
    drawtext=text='BATTLE HARNESS':fontsize=22:fontcolor=0xef4444:x=(w-tw)/2:y=560:enable='gte(t,2.3)',\
    drawtext=text='4 AI agents • 16 economic scenarios • 954 verified txs':fontsize=18:fontcolor=0x707070:x=(w-tw)/2:y=600:enable='gte(t,2.5)'\
  " -t 5 -c:v libx264 -pix_fmt yuv420p "$OUT/04-arch.mp4"

# Stats slide  
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=5" \
  -vf "\
    drawtext=text='Live Results':fontsize=56:fontcolor=white:x=(w-tw)/2:y=150:enable='gte(t,0.3)',\
    drawtext=text='954':fontsize=120:fontcolor=0x22c55e:x=300:y=320:enable='gte(t,0.8)',\
    drawtext=text='Transactions':fontsize=24:fontcolor=0x707070:x=300:y=450:enable='gte(t,1)',\
    drawtext=text='99.4%%':fontsize=120:fontcolor=0x3b82f6:x=800:y=320:enable='gte(t,1.2)',\
    drawtext=text='Success Rate':fontsize=24:fontcolor=0x707070:x=870:y=450:enable='gte(t,1.4)',\
    drawtext=text='33 XLM':fontsize=120:fontcolor=0xf59e0b:x=1300:y=320:enable='gte(t,1.6)',\
    drawtext=text='Volume':fontsize=24:fontcolor=0x707070:x=1400:y=450:enable='gte(t,1.8)',\
    drawtext=text='Live on Stellar Testnet • Verifiable on Horizon':fontsize=22:fontcolor=0x707070:x=(w-tw)/2:y=560:enable='gte(t,2.5)',\
    drawtext=text='ghost-clio.github.io/stellar-agent-mesh':fontsize=20:fontcolor=0x3b82f6:x=(w-tw)/2:y=620:enable='gte(t,3)'\
  " -t 5 -c:v libx264 -pix_fmt yuv420p "$OUT/05-stats.mp4"

# End card
ffmpeg -y -f lavfi -i "color=c=0x0a0a0a:s=${W}x${H}:d=4" \
  -vf "\
    drawtext=text='Stellar Agent Mesh':fontsize=56:fontcolor=white:x=(w-tw)/2:y=h/2-100:enable='gte(t,0.3)',\
    drawtext=text='github.com/ghost-clio/stellar-agent-mesh':fontsize=24:fontcolor=0x3b82f6:x=(w-tw)/2:y=h/2:enable='gte(t,0.8)',\
    drawtext=text='Built for Stellar Hacks: Agents':fontsize=20:fontcolor=0x707070:x=(w-tw)/2:y=h/2+60:enable='gte(t,1.2)'\
  " -t 4 -c:v libx264 -pix_fmt yuv420p "$OUT/06-end.mp4"

# Concatenate all slides
cat > "$OUT/concat.txt" << 'LIST'
file '01-title.mp4'
file '02-problem.mp4'
file '03-solution.mp4'
file '04-arch.mp4'
file '05-stats.mp4'
file '06-end.mp4'
LIST

ffmpeg -y -f concat -safe 0 -i "$OUT/concat.txt" \
  -c:v libx264 -pix_fmt yuv420p \
  "$OUT/stellar-mesh-demo-silent.mp4"

# Check if we have Song 24
SONG=""
if [ -f ~/clawd/songs/song-24*.mp3 ]; then
  SONG=$(ls ~/clawd/songs/song-24*.mp3 | head -1)
elif [ -f /tmp/song-24*.mp3 ]; then
  SONG=$(ls /tmp/song-24*.mp3 | head -1)
fi

if [ -n "$SONG" ]; then
  # Add audio
  ffmpeg -y -i "$OUT/stellar-mesh-demo-silent.mp4" -i "$SONG" \
    -c:v copy -c:a aac -shortest \
    -af "afade=t=in:d=1,afade=t=out:st=29:d=2" \
    "$OUT/stellar-mesh-demo.mp4"
  echo "Demo with audio: $OUT/stellar-mesh-demo.mp4"
else
  cp "$OUT/stellar-mesh-demo-silent.mp4" "$OUT/stellar-mesh-demo.mp4"
  echo "Demo (silent): $OUT/stellar-mesh-demo.mp4"
fi

# Get duration
ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUT/stellar-mesh-demo.mp4"
echo "Done!"
