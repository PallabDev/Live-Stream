# Checkpoint Registry & Rollback Log

This file tracks stable commit checkpoints for easy rollback if any future changes cause regressions or issues.

---

## Current Active Checkpoint

- **Latest Commit Hash**: `2c06658b7ad66309d744295f0a17bfe026bab539`
- **Commit Date**: `2026-07-22 00:30:44 +0530`
- **Commit Message**: `feat: implement video player and stream status templates using EJS and HLS.js`
- **Status**: Stable & Verified

---

## How to Roll Back to this Checkpoint

If any future changes cause issues or break stream functionality, run the following command in your terminal:

```bash
git reset --hard 2c06658b7ad66309d744295f0a17bfe026bab539
```

Or to create a new branch from this stable point:

```bash
git checkout -b rollback-stable 2c06658b7ad66309d744295f0a17bfe026bab539
```

---

## Recent Commit History Log

| Commit Hash | Author | Date | Summary |
| :--- | :--- | :--- | :--- |
| `2c06658` | Pallab Karmakar | 2026-07-22 | Implement video player and stream status templates using EJS and HLS.js |
| `ddf3c82` | Pallab Karmakar | 2026-07-21 | Add Coturn TURN server to fix WebRTC on strict mobile networks (Jio) |
| `46e9a97` | Pallab Karmakar | 2026-07-21 | Permanently hide and disable mute controls on previewPlayer to prevent echo |
| `8918f86` | Pallab Karmakar | 2026-07-21 | Mute previewPlayer to prevent double-audio echo on broadcaster side |
| `79f1669` | Pallab Karmakar | 2026-07-21 | Dual-player architecture for audio sync & zero-freeze WebRTC streaming |
