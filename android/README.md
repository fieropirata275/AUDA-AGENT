# AUDA for Android

Talk to AUDA, supervise its work, and run a group chat with every AUDA agent —
from your phone, using the same design system as the web app.

* **Finds AUDA by itself** on your local network (mDNS `_auda._tcp`, a UDP
  broadcast fallback on port 4611, and a quick subnet sweep), and shows every
  instance with its live presence. Pick the one to work from; switch any time.
* **Pairing**: if an instance requires it, the app shows a 6-digit code that you
  approve in AUDA → Connections. The token is stored on the phone and can be
  revoked from AUDA.
* **Home**: AUDA's glyph and presence, what it's working on, what it's watching,
  and every decision that needs you (approve or decline in place).
* **Chat**: a 1:1 conversation with AUDA.
* **Team**: the group chat with all agents. `/task …` assigns work, `@agent`
  messages an agent mid-task, and you can attach files or whole folders (the
  folder structure is preserved in AUDA's inbox).
* **Work**: tasks by state, task details (plan, independent review, sub-agents,
  timeline), pause/resume/stop, message an agent, and **Assign work** with
  "done when" criteria and attachments.

## Build

CI builds a debug and a release APK on every push (see `.github/workflows/ci.yml`,
artifact **auda-android**). Locally, with Android Studio or the Android SDK:

```bash
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

The release APK in CI is signed with the debug key so it installs directly; sign
with your own key before distributing it.

Fonts (Instrument Sans, Instrument Serif, JetBrains Mono) are licensed under the
SIL Open Font License 1.1.
