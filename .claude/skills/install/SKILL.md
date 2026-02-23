---
name: install
description: Set up browser-console-bridge by installing dependencies, symlinking the skill, and starting the server. Chrome extension must be loaded manually.
---

# Install Browser Console Bridge

Sets up everything needed to use BCB with Claude Code.

## Usage

```
/install
```

## What It Does

1. Creates the Python venv and installs dependencies
2. Symlinks the `browser-console` skill to `~/.claude/skills/`
3. Symlinks the `bcb-wrapper-reminder` hook and registers it in `~/.claude/settings.json`
4. Starts the BCB server
5. Verifies the server is running
6. Reminds you to load the Chrome extension if not already done

## Process

### 1. Determine repo root

```bash
REPO_ROOT="$(pwd)"
# Confirm we're in the right place
ls "$REPO_ROOT/server/bridge_server.py" || echo "ERROR: run /install from the browser-console-bridge repo root"
```

### 2. Set up Python venv

```bash
if [ ! -d "$REPO_ROOT/.venv" ]; then
  python3 -m venv "$REPO_ROOT/.venv"
  echo "created: .venv"
else
  echo "exists: .venv"
fi

"$REPO_ROOT/.venv/bin/pip" install -q -r "$REPO_ROOT/requirements.txt"
echo "dependencies installed"
```

### 3. Symlink the browser-console skill

```bash
SKILL_SRC="$REPO_ROOT/.claude/skills/browser-console"
SKILL_LINK="$HOME/.claude/skills/browser-console"

mkdir -p "$HOME/.claude/skills"

if [ -L "$SKILL_LINK" ]; then
  ln -sf "$SKILL_SRC" "$SKILL_LINK"
  echo "updated: $SKILL_LINK -> $SKILL_SRC"
elif [ -e "$SKILL_LINK" ]; then
  echo "skipped: $SKILL_LINK already exists (not a symlink) — remove it manually if you want to replace it"
else
  ln -s "$SKILL_SRC" "$SKILL_LINK"
  echo "linked: $SKILL_LINK -> $SKILL_SRC"
fi
```

### 4. Symlink the BCB wrapper reminder hook

```bash
HOOK_SRC="$REPO_ROOT/hooks/bcb-wrapper-reminder.py"
HOOK_LINK="$HOME/.claude/hooks/bcb-wrapper-reminder.py"

mkdir -p "$HOME/.claude/hooks"

if [ -L "$HOOK_LINK" ]; then
  ln -sf "$HOOK_SRC" "$HOOK_LINK"
  echo "updated: $HOOK_LINK -> $HOOK_SRC"
elif [ -e "$HOOK_LINK" ]; then
  echo "skipped: $HOOK_LINK already exists (not a symlink) — remove it manually to replace"
else
  ln -s "$HOOK_SRC" "$HOOK_LINK"
  echo "linked: $HOOK_LINK -> $HOOK_SRC"
fi
```

Then merge the PostToolUse entry into `~/.claude/settings.json`. Read the file first, then use Python to merge:

```bash
python3 - <<'EOF'
import json, os

settings_path = os.path.expanduser("~/.claude/settings.json")

with open(settings_path) as f:
    settings = json.load(f)

new_hook = {
    "matcher": "Bash",
    "hooks": [
        {
            "type": "command",
            "command": "~/.claude/hooks/bcb-wrapper-reminder.py"
        }
    ]
}

hooks = settings.setdefault("hooks", {})
post_tool_use = hooks.setdefault("PostToolUse", [])

# Only add if not already present
already_present = any(
    h.get("matcher") == "Bash" and
    any(hk.get("command") == "~/.claude/hooks/bcb-wrapper-reminder.py"
        for hk in h.get("hooks", []))
    for h in post_tool_use
)

if not already_present:
    post_tool_use.append(new_hook)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    print("added: PostToolUse hook entry for bcb-wrapper-reminder")
else:
    print("skipped: bcb-wrapper-reminder hook already in settings.json")
EOF
```

### 5. Start the server

```bash
bash "$REPO_ROOT/bin/bcb-server-start"
sleep 2
```

### 6. Verify

```bash
curl -sf http://localhost:18080/health | python3 -m json.tool
```

Look for `"status": "ok"`. If `"extension_connected"` is `false`, the Chrome extension needs to be loaded (see step 7).

### 7. Chrome extension (manual step)

The Chrome extension cannot be installed automatically. If not already done:

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select: `<repo_root>/extension/`

Once loaded, the extension connects to the server automatically whenever it's running. You only need to do this once — Chrome remembers installed extensions.

### 8. Report

Print a summary:

```bash
echo ""
echo "=== Browser Console Bridge ==="
echo "Server:    $(curl -sf http://localhost:18080/health | python3 -c 'import sys,json; h=json.load(sys.stdin); print(f"running (extension_connected={h[\"extension_connected\"]})")'  2>/dev/null || echo "not running")"
echo "Skill:     $(ls -la ~/.claude/skills/browser-console 2>/dev/null || echo "not linked")"
echo "Hook:      $(ls -la ~/.claude/hooks/bcb-wrapper-reminder.py 2>/dev/null || echo "not linked")"
echo ""
echo "If extension_connected is false, load the Chrome extension from: $REPO_ROOT/extension/"
```
