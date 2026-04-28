# Engosoft Zoom Bot 🤖

يجوين الميتنج تلقائياً كـ host → يعمل MuteAll → يترقب المحاضر.

## Architecture

```
Zoom Webhook (meeting.started)
    ↓
n8n Webhook Node
    ↓
HTTP POST → /join (this server)
    ↓
Puppeteer يفتح bot.html
    ↓
Zoom Web SDK يجوين كـ host
    ↓
muteAll() ✅
    ↓
onUserJoin → لو المحاضر → unmute + log
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status |
| POST | `/join` | Bot يجوين ميتنج |
| POST | `/leave` | Bot يخرج من ميتنج |
| GET | `/status/:meetingNumber` | حالة الـ session |
| GET | `/signature?meetingNumber=X&role=1` | جيب SDK signature |

## Authentication
كل الـ endpoints (غير /health) محتاجة header:
```
x-bot-key: engosoft-secret-2026
```

## Deploy على Coolify

1. ارفع الـ code على GitHub private repo
2. في Coolify: New Service → Docker
3. Environment Variables:
   ```
   ZOOM_SDK_KEY=R0woOwvFQcOZ8F9aU3vnQA
   ZOOM_SDK_SECRET=rgIK9yJ46iQiW5GspsKUTrtcR9eGCHZi
   SECRET_KEY=غير-الكلمة-دي
   PORT=3000
   ```
4. Port: 3000
5. Deploy

## n8n Workflow

في n8n، بعد ما تستقبل `meeting.started` webhook من Zoom:

```json
POST https://your-bot.coolify.domain/join
Headers: { "x-bot-key": "your-secret" }
Body: {
  "meetingNumber": "{{ $json.payload.object.id }}",
  "password": "{{ $json.payload.object.password }}",
  "lecturerName": "{{ $json.payload.object.host_email }}",
  "lecturerEmail": "{{ $json.payload.object.host_email }}"
}
```

## ملاحظات

- `makeCoHost` مش متاح في Zoom Web SDK بشكل مباشر
- الحل الحالي: المحاضر يتعمله `alternative_hosts` قبل الميتنج عبر REST API
- الـ bot بيعمل unmute للمحاضر لما يجوين
