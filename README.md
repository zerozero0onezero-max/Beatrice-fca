# Beatrice-fca: لوحة تحكم ذكية وبوت فيسبوك مع نظام الإعداد الذاتي والاستعادة التلقائية

نظام إعداد ذاتي متكامل (First-Run Setup & Auto-Recovery Engine) لمشروع **Beatrice-fca**. يتيح نقل واستنساخ المشروع في أي بيئة جديدة (سيرفرات VPS، حاويات Docker، الأجهزة الشخصية) بأقل تدخل يدوي ممكن، مع التحقق من البيئة وتنزيل النماذج والخطوط الناقصة وفحص سلامتها وتشغيل البوت ولوحة التحكم بأمان.

---

## ⚡ التشغيل السريع في أي بيئة جديدة (First-Run Quickstart)

```bash
# 1. استنساخ المشروع من GitHub
git clone https://github.com/USERNAME/REPO_NAME.git
cd REPO_NAME

# 2. تثبيت الحزم (أو تشغيل الإعداد التلقائي مباشرة)
npm install

# 3. تشغيل النظام الكامل (يقوم بالفحص الذاتي والإعداد والبناء ثم التشغيل)
npm start
```

بعد التشغيل، افتح المتصفح على:
```
http://localhost:3000
```

---

## 🧭 أوامر الإدارة والصيانة الذاتية (Management & Maintenance CLI)

يوفر المشروع مجموعة أوامر مستقلة وآمنة عبر `npm run`:

| الأمر | الوظيفة والهدف |
|---|---|
| `npm run setup` | تنفيذ الإعداد الذاتي الكامل (فحص البيئة، تنزيل النواقص، التحقق من البصمات، بناء اللوحة) |
| `npm run setup:check` | **فحص فقط (Read-only)** دون تحميل أو تعديل أي ملف في المشروع |
| `npm run setup:doctor` | تقرير تشخيصي شامل للبيئة (نظام التشغيل، Node، الذاكرة، الأمان، النماذج، قواعد البيانات) |
| `npm run setup:voices` | فحص محركات الصوت وتوليد عينة صوتية محلية تجريبية للتحقق من جاهزية Kokoro-82M و Gemini |
| `npm run setup:download` | تنزيل الأصول والنماذج الناقصة فقط دون تشغيل الخادم |
| `npm run setup:retry` | إعادة محاولة تنزيل أي مكون فشل تنزيله سابقاً |
| `npm test` | تشغيل الاختبارات المؤتمتة (Unit & Integration Tests) عبر Node Test Runner |

---

## 📦 المكونات المدارة ومصادر التنزيل ومواقع الحفظ

| المكون | المصدر الرسمي المعتمد | المسار الدائم في المشروع | الحجم المتوقع | درجة الأهمية |
|---|---|---|---|---|
| **أوزان Kokoro-82M ONNX** | `onnx-community/Kokoro-82M-ONNX` (HuggingFace) | `data/models_cache/onnx-community/...` | ~89 MB | اختياري (يدعم Gemini Fallback) |
| **ملف إعداد Kokoro** | `onnx-community/Kokoro-82M-ONNX` (HuggingFace) | `data/models_cache/onnx-community/...` | 44 B | اختياري |
| **رموز ومفردات Kokoro** | `onnx-community/Kokoro-82M-ONNX` (HuggingFace) | `data/models_cache/onnx-community/...` | 4.5 KB | اختياري |
| **نبرة صوت Bella (Beatrice)** | `onnx-community/Kokoro-82M-ONNX` (HuggingFace) | `voices/af_bella.bin` | ~510 KB | أساسي (مرفوع ومحمي) |
| **نبرات الصوت الإضافية** | `onnx-community/Kokoro-82M-ONNX` (HuggingFace) | `voices/*.bin` | ~510 KB لكل نبرة | اختياري |
| **خط Noto Color Emoji العادي** | `googlefonts/noto-emoji` (Google Fonts) | `Beatrice-fca/scripts/cmds/assets/font/` | ~24 MB | أساسي لبطاقات الرتب والصور |
| **خط Noto Color Emoji المدمج** | `googlefonts/noto-emoji` (Google Fonts) | `Beatrice-fca/scripts/cmds/assets/font/` | ~11 MB | احتياطي مدمج |
| **واجهة لوحة التحكم** | مبنية محلياً عبر `Vite` | `dist/index.html` | ~680 KB | أساسي للتحكم عبر الويب |

---

## 📝 سجل الإعداد والعمليات (First-Run Setup Log)

يتم تسجيل كافة الفحوصات والتحميلات والبصمات في ملف سجل دائم ومنظم:
```
logs/first-run-setup.log
```
يستخدم السجل وسوماً معيارية واضحة:
* `[INFO]` : معلومات عامة وتوقيتات بدء العمليات.
* `[CHECK]` : فحص المتطلبات والموارد.
* `[INSTALL]` : تثبيت مكتبات Node.js.
* `[DOWNLOAD]` : تنزيل النماذج والخطوط مع شريط التقدم.
* `[OK]` : نجاح واكتمال فحص أو تحميل المكون.
* `[SKIP]` : تجاوز تنزيل المكون لوجوده مسبقاً وبصمته سليمة.
* `[WARN]` : تحذيرات غير معطلة (مثل ميزة اختيارية معطلة).
* `[ERROR]` : أخطاء الإعداد مع توضيح السبب الجذري.
* `[SUMMARY]` : ملخص الجاهزية النهائي مع عدد المكونات الناجحة والفاشلة.

> 🔒 **حماية البيانات والأسرار:** السجل مزود بفلتر تطهير تلقائي (Automatic Sanitizer) يقوم بتشفير وحجب مفاتيح API، كوكيز الجلسات (`c_user`, `xs`)، كلمات المرور، ورموز التوثيق قبل طباعتها أو كتابتها في السجل.

---

## 🐳 التشغيل عبر Docker و Docker Compose

المشروع مزود بملفي `Dockerfile` و `docker-compose.yml` جاهزين للإنتاج:

```bash
# تشغيل الحاوية في الخلفية
docker compose up -d

# متابعة السجلات المباشرة
docker compose logs -f
```

تم ضبط وحدات التخزين الدائمة (Volumes) للحفاظ على البيانات والنماذج عبر عمليات إعادة التشغيل:
* `./data` ⬅️ تخزين نماذج الذكاء الاصطناعي وكاش الصوتيات.
* `./logs` ⬅️ السجلات الدورية للتشغيل والإعداد.
* `./voices` ⬅️ ملفات نبرات الصوت.
* `./Beatrice-fca/core/database/data` ⬅️ قواعد بيانات SQLite للمستخدمين والمجموعات.

---

## 🔒 إعدادات الأمان وملفات الاعتماد

1. **كوكيز فيسبوك (AppState / ncstate.json):**
   * يتم استبعادها تلقائياً من GitHub عبر `.gitignore` لمنع سرقة حسابك.
   * في البيئة الجديدة، ألصق الكوكيز من تبويب **"AppState / Cookies"** في لوحة التحكم، أو ضع الملف في `Beatrice-fca/ncstate.json`.
2. **مفاتيح Gemini API:**
   * عرّف المتغير `GEMINI_API_KEY` في ملف `.env` (راجع `.env.example`).
   * أو أضف المفاتيح عبر تبويب **"Gemini Keys"** المشفر في لوحة التحكم.
