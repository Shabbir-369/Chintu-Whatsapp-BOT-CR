# 🤖 NOT YOUR TYPE — Bot Testing Guide + Fix Status

> **Bot restarted with all fixes applied.**  
> Run `npm run import:data` once in a NEW terminal to refresh timetable data in DB.

---

## 🔧 FIXES APPLIED (restart bot to pick up)

| # | Issue | Fix Applied |
|---|---|---|
| 🔴 | **Bot replying/reacting to EVERY group message** | `GROUP_AMBIENT_REPLY_CHANCE` lowered from 100% → 15%. `REACTION_CHANCE` 12% → 8% |
| 🔴 | **Group members (LID users) not getting replies** | `burstKey` now uses `senderJid` not `person.id` (which was `undefined` for LID). Group logic restructured. |
| 🔴 | **Burst handling not working** | Same LID fix + owner now correctly bypasses burst |
| 🔴 | **Mass Bunk Stats showing personal bunk** | Was passing date string instead of `Date` object to `runMassBunkAnalysis`. Fixed. |
| 🔴 | **Conversation Starter not working** | Added `force=true` bypass so owner trigger skips morning/alive/quiet checks |
| 🟡 | **Marks giving garbage output** | `extractMarksData` now only shows entries with `maxMarks > 0`. Better empty message. |
| 🟡 | **Memory not working** | Persona prompt now explicitly tells LLM WHEN to write memory_ops with examples |
| 🟡 | **Timetable showing wrong data** | Fixed `timeToMinutes` (was corrupting `:00` times). Fixed `isToday` (was always false). **Also run `npm run import:data`** |
| 🟡 | **Send message not recognizing person** | Improved regex: `"Rahul ko bol X"`, `"Rahul ko bhej X"` now all parsed correctly |
| 🟡 | **Holiday/Exam queries not exact** | Same timetable fix + `isToday` fix improves response accuracy |

---

## 📋 HOW TO USE THIS GUIDE

- **Owner phone** = your phone (the WhatsApp that has the bot number saved)
- **Test phone** = a second WhatsApp number (friend's phone, second SIM)
- Messages in `"quotes"` are what you type in WhatsApp
- `→` shows expected response

> **FIRST: Open a new terminal and run:**  
> ```
> npm run import:data
> ```
> This refreshes the timetable and calendar data in the database.

---

## 🔑 SECTION 1 — OWNER CONSOLE

> DM the bot number from your phone.

### 1.1 Basic Status Check ✅
```
Send: "status"
→ WhatsApp connected, AI calls count, enabled groups, pending approvals
```

### 1.2 List All Groups ✅
```
Send: "groups dikha"
→ Lists all groups with ON/OFF and mode
```

### 1.3 Timetable — FIXED (run import:data first) ⚠️
```
Send: "aaj kya class hai"
→ Should show today's classes with ✅/🔵/⏳ time markers

Send: "kal kya class hai"
→ Should show tomorrow's simple list

Send: "timetable"
→ Full info
```
> If still wrong: run `npm run import:data` in a new terminal window.

### 1.4 Holiday / Exam Queries — FIXED ⚠️
```
Send: "next holiday kab hai"
→ "agli chhutti: Vijayadashami — Tue 20 Oct, 12 din baad"

Send: "MST kab hai"
→ "MST-II: Mon 16 Nov – Fri 20 Nov (39 din baad)"
```

### 1.5 Enable/Disable a Group ✅
```
Send: "enable [group name]"
→ "done, [group] mein ab bolega"

Send: "disable [group name]"
→ "[group] band kar diya"
```

### 1.6 Set Group Mode — NOT YET CHECKED
```
Send: "[group name] mein ambient mode"
Send: "[group name] mein trigger mode"
Send: "[group name] mein mute mode"
→ Should confirm mode change
```

### 1.7 Pending Approvals ✅
```
Send: "pending approvals"
→ Lists pending DM/name requests with codes
```

### 1.8 Add a Day Note — NOT YET CHECKED
```
Send: "kal class cancel hai"
→ "note add kar diya"
```

### 1.9 Send Message to Someone — FIXED ⚠️
```
Send: "Rahul ko bol class mein aa"
Send: "Priya ko bhej yaar kal aa jaana"
→ Bot sends that message to them
```
> Note: person must have chatted with bot before (be in the DB) for lookup to work.

### 1.10 Forget a Person ✅
```
Send: "bhul ja Rahul"
→ "Rahul ke baare mein sab bhool gaya"
```

### 1.11 Free Chat with Bot ✅
```
Send: "kya scene hai aaj"
→ Personality-driven Hinglish reply
```

---

## 🔐 SECTION 2 — DM APPROVAL FLOW

### 2.1 First Message (New User) ✅ WORKING
```
[Test phone] Send any message
→ Gets: "chintu ne tumhara DM dekh liya 👀 pehle owner se green signal chahiye"
→ Owner gets approval card with code like "D4"
```

### 2.2 Approve ✅ WORKING
```
[Owner] Send: "D4 yes"
→ Person gets: "owner ne haan bol diya. ab bol, kya scene hai"
```

### 2.3 Deny ✅ WORKING
```
[Owner] Send: "D5 no"
→ Person gets nothing (silent block)
```

### 2.4 Pending = Silent ✅ WORKING
```
[Test phone] Send 2nd message while pending
→ Bot ignores it (no double reply)
```

---

## 💬 SECTION 3 — APPROVED USER DM FEATURES

### 3.1 Free Chat ✅ WORKING
```
Send: "kya chal raha hai"
→ Savage/witty Hinglish reply
```

### 3.2 Timetable Questions ✅ WORKING
```
Send: "aaj kya class hai"
Send: "kal class hai kya"
Send: "next holiday kab"
```

### 3.3 POD Account Linking ✅ WORKING
```
Send: "link pod" or "!link"
→ Starts credential linking flow
```

### 3.4 No POD → Prompt to Link ✅ WORKING
```
Send: "meri attendance kitni hai"
→ "pod account link nahi hai abhi. 'link pod' bol..."
```

### 3.5 POD Data (with linked account) ✅ WORKING
```
Send: "attendance"     → course-wise %
Send: "bunk"           → bunk calculator
Send: "2 bunk karu?"   → what-if per course (🟢🟡🔴)
Send: "marks"          → FIXED: now shows proper marks or clear "no data" msg
Send: "koi notice aaya" → latest POD notices
```

### 3.6 Unlink POD ✅ WORKING
```
Send: "unlink pod"
→ Unlinks and confirms
```

### 3.7 Personal Data in Group → Redirect — NOT YET CHECKED
```
[In group] Send: "meri attendance bata"
→ "DM mein bol, yahan sabko nahi dikhana 👀"
```

---

## 👥 SECTION 4 — GROUP FEATURES

### 4.1 Reply to Non-Owner Members — FIXED ⚠️
```
[From a non-owner group member] Send any message
→ Bot should now respond (was blocked by LID identity bug)
→ No more "LID message has no phone identity hint" breaking replies
```
> Test this: have a friend (approved user) send "chintu kya scene hai" in the group.

### 4.2 Timetable in Group — FIXED ⚠️
```
Send: "aaj kya class hai"
→ Should show correct timetable (after import:data)
```

### 4.3 Mass Bunk Detection — PARTIALLY WORKING ⚠️
```
Send: "kal sab bunk karein? 😂"
→ Bot posts ONE savage line (was working)
→ Owner NOW gets a DM with stats (was broken — FIXED)
```
> Owner should get "mass bunk analysis" report within 5 seconds.

### 4.4 Burst Message Handling — FIXED ⚠️
```
Send 3 messages VERY quickly (< 2 seconds):
  "bhai"
  "sun"
  "kya scene hai"
→ Bot should reply ONLY ONCE after ~1.5s pause
```

### 4.5 Voice Note Handling (test this)
```
Send a voice note
→ "kaan kharab hai abhi, likh ke bhej"
```

### 4.6 Bot Reactions — FIXED ⚠️
```
Bot should now react rarely (8% chance) and reply selectively (15% ambient chance)
→ NOT on every single message anymore
→ Feels more like a real person now
```

### 4.7 Personal Data in Group ✅ WORKING
```
Send: "mera attendance bata"
→ "DM mein bol, yahan sabko nahi dikhana 👀"
```

### 4.8 Admin Command Refusal ✅ WORKING
### 4.9 Attack on Owner Detection ✅ WORKING
### 4.10 Serious Distress Detection ✅ WORKING
### 4.11 Ambient Mode ✅ WORKING

---

## 🧠 SECTION 5 — MEMORY & PERSONALITY

### 5.1-5.4 Name Flow — NOT YET TESTED
```
[DM] Send: "mera naam Arjun hai"
→ Owner gets name approval card "N3"

[Owner] Send: "N3 yes"
→ Bot now calls them Arjun
```

### 5.5 Memory Persistence — FIXED ⚠️
```
Send: "meri exam kal hai"
→ Bot should write this to memory (now explicitly instructed)

Send later: "kya chal raha hai"
→ Bot may reference the exam
```
> Memory works best over multiple messages in one session.

### 5.6 Promise Detection — FIXED ⚠️
```
Send: "kal bataunga notes ke baare mein"
→ Bot writes promise to memory (no visible output, internal)
```

---

## ⚙️ SECTION 6 — OWNER POD DATA

### 6.1 Your Attendance ✅ WORKING
```
Send: "meri attendance bata"
```

### 6.2 Bunk Calculator — DEPENDS ON TIMETABLE DATA ⚠️
```
Send: "kitna bunk kar sakta hoon"
→ Works after import:data
```

### 6.3 Your Marks — FIXED ⚠️
```
Send: "marks bata"
→ Now shows real marks OR clear message "abhi koi marks available nahi"
→ No more garbage output
```

---

## 📊 SECTION 7 — SCHEDULED / AUTOMATIC FEATURES

### 7.1 Conversation Starter — FIXED ⚠️
```
[Owner DM] Send: "conversation start karo"
→ NOW WORKS: bypasses morning/alive checks
→ "conversation starter bhej diya enabled groups mein"
→ Check the group — starter message should appear
```

| Feature | When | Status |
|---|---|---|
| Morning Greeting | 07:45 IST | Auto |
| Class Reminder | Before class | Auto |
| Nightly Memory Decay | 03:00 IST | Auto |
| POD Notice Poll | Every 5 min | ✅ Running |
| Conversation Starter | Manual or auto | FIXED |

---

## 🛠️ SECTION 8 — EDGE CASES

### 8.1 AI Budget Exhausted
```
→ Bot falls back to hardcoded lines (working by design)
→ Current: 117/400 AI calls today
```

### 8.2 Blocked User — NEEDS IMPROVEMENT
```
Deny a user → they should be completely silent-blocked
→ Currently working but needs more robustness testing
```

### 8.3 Quote-Reply Approval ✅ WORKING
```
[Owner] Quote-reply on the card + type "yes"
→ Works same as "D4 yes"
```

### 8.4 POD Down ✅ WORKING
```
→ "pod ne abhi dhoka diya, thodi der baad"
```

### 8.5 Unknown Command / Gibberish
```
[Owner DM] Send: "xyzabc 123 random"
→ Should fall through to LLM as free chat
→ If not working: intent parser confidence too low, falls back to null → check logs
```

### 8.6 Mass Bunk Stats — FIXED ⚠️
```
[Owner DM] Send: "mass bunk stats dikha"
→ "mass bunk analysis chal rahi hai — report thodi der mein aayegi"
→ Report arrives in your DM within 5 seconds
→ Shows: linked count, yellow zone, red zone members
```

---

## ✅ UPDATED CHECKLIST

```
OWNER CONSOLE:
[✅] "status" → works
[✅] "groups dikha" → works
[⚠️] "aaj kya class hai" → FIXED (run import:data)
[⚠️] "kal kya class hai" → FIXED (run import:data)
[✅] Enable/disable group → works
[🔲] Set group mode → not yet tested
[⚠️] Send message to person → FIXED regex
[✅] "bhul ja [name]" → works

DM APPROVAL FLOW:
[✅] New DM → approval card to owner
[✅] "D4 yes" → approved + notified
[✅] "D4 no" → denied silently
[✅] Pending → ignored

APPROVED USER DM:
[✅] Free chat → Hinglish personality
[✅] Timetable questions → works
[✅] No POD → link prompt
[✅] "link pod" → linking flow
[✅] Attendance, bunk, what-if, notices → work
[⚠️] Marks → FIXED (no more garbage)
[✅] Unlink pod → works

GROUP FEATURES:
[⚠️] Non-owner members reply → FIXED (LID bug)
[⚠️] Timetable in group → FIXED
[⚠️] Mass bunk → savage line ✅ + owner DM FIXED
[⚠️] Burst → FIXED
[🔲] Voice note → test pending
[⚠️] Bot over-reacting → FIXED (15% not 100%)
[✅] Personal data → DM redirect
[✅] Admin refusal → works
[✅] Attack on owner → defender mode
[✅] Distress → serious mode
[✅] Ambient mode → works

MEMORY:
[⚠️] Memory ops → FIXED prompt
[🔲] Name flow → not yet tested

ERROR HANDLING:
[⚠️] Mass bunk stats → FIXED
[✅] POD down → graceful error
[✅] Quote-reply approval → works
[✅] Blocked user → silent
```

---

## 🐛 CHECKING LOGS

```
data/bot-runtime.log        — all activity
data/bot-runtime-error.log  — crashes/errors
```

Or in the terminal where `npm start` is running, look for:
- `WARN` lines for non-fatal issues
- `ERROR` lines for actual bugs
- `Decision` lines show what the bot decided (REPLY/REACT/IGNORE) for each message

---

## ⚡ QUICK RESTART STEPS

```
1. Stop bot: Ctrl+C in the terminal
2. npm run import:data    ← refresh timetable data
3. npm start              ← start bot again
```

---

*Testing Guide | Not Your Type Bot | Medicaps University, Indore | Updated Oct 8, 2026*
