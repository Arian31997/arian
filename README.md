# VELORA — بک‌اند و سایت

Node.js + Express + SQLite. فرانت‌اند در `public/index.html` است و از همان دامنه به `/api` وصل می‌شود.

## اجرا
```
npm install
cp .env.example .env     # JWT_SECRET و SERVER_KEY را پر کنید
npm start
```
سایت روی http://localhost:3000 باز می‌شود. پایگاه‌داده فایل `velora.db` است؛ از آن بک‌آپ بگیرید.

## استقرار
- حتماً پشت HTTPS اجرا کنید (nginx یا Cloudflare) و `NODE_ENV=production` و `TRUST_PROXY=1` بگذارید.
- کوکی نشست `httpOnly` است و در حالت production فقط روی HTTPS ارسال می‌شود.
- با `pm2 start server.js --name velora` دائمی کنید.

## API
| مسیر | توضیح |
|---|---|
| POST /api/register, /api/login, /api/logout, GET /api/me | حساب کاربری |
| POST /api/shop/buy `{id}` | خرید اشتراک (silver, gold, plat) |
| POST /api/tickets, /api/apps | تیکت و درخواست ورود |
| POST/DELETE /api/link/dc، /api/link/sm | لینک دیسکورد و استیم |
| POST /api/avatar `{img}` | عکس پروفایل (حداکثر ۵۰۰KB) |
| GET /api/servers | وضعیت سرورها و جایگاه صف کاربر |
| POST/DELETE /api/queue/:id | ورود و خروج از صف |

### اتصال به سرور بازی (هدر `X-Server-Key: <SERVER_KEY>`)
- `POST /api/servers/wl/players` با بدنه‌ی `{"players": 12}` تعداد بازیکنان را آپدیت می‌کند. از اسکریپت سمت سرور VMP هر چند ثانیه صدا بزنید.
- `POST /api/servers/wl/queue/pop` نفر اول صف را برمی‌گرداند و از صف حذف می‌کند: `{"username":"..."}`. سمت سرور بازی این نام کاربری را برای اجازه‌ی ورود چک کنید.

## مهم
- **پرداخت:** `PAYMENT_MODE=demo` یعنی اشتراک بدون پرداخت فعال می‌شود. قبل از انتشار، درگاه واقعی (مثل زرین‌پال) را در `/api/shop/buy` وصل کنید؛ محل دقیقش در کد کامنت شده است.
- **ایمیل/موبایل:** تأیید ایمیل و پیامک و بازیابی رمز هنوز پیاده نشده است.
- **پنل ادمین:** بررسی تیکت‌ها و درخواست‌ها فعلاً مستقیم از دیتابیس انجام می‌شود (`sqlite3 velora.db`).
