import { prisma } from '../prisma.js';

const PRAYER_ROOM_INVENTORY = [
  {
    "organization": "مستشفى الملك فهد الجامعي بالخبر",
    "label": "مستشفى الملك فهد الجامعي",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الخبر",
    "coordinator": {
      "name": "أ.خالد محمد السويدان",
      "jobTitle": "مدير مكتب المدير التنفيذي بالمستشفى",
      "mobile": "0556881886",
      "extension": "55011",
      "email": "kalswedan@iau.edu.sa"
    }
  },
  {
    "organization": "كلية العلوم والدراسات الإنسانية الجبيل",
    "label": "كلية العلوم والدراسات الإنسانية بالجبيل",
    "buildingCode": null,
    "women": 1,
    "men": 0,
    "city": "الجبيل",
    "coordinator": {
      "name": "أ.وفاء إبراهيم الرقطان",
      "jobTitle": "سكرتيرة خاص",
      "mobile": "0555974747",
      "extension": "38686",
      "email": "wialraqtan@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الدراسات التطبيقية وخدمة المجتمع- شطر الطلاب",
    "label": "كلية الدراسات التطبيقية وخدمة المجتمع - شطر الطلاب",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام"
  },
  {
    "organization": "كلية العمارة والتخطيط",
    "label": "كلية العمارة والتخطيط",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.أحمد بن زاهر الشهري",
      "jobTitle": "مسجل معلومات",
      "mobile": "0550303043",
      "extension": "31863",
      "email": "azhalshehri@iau.edu.sa"
    }
  },
  {
    "organization": "كلية علوم الحاسب وتقنية المعلوماتA11",
    "label": "كلية علوم الحاسب وتقنية المعلومات A11",
    "buildingCode": "A11",
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.بدر سعود السالم",
      "jobTitle": "مساعد إداري",
      "mobile": "0550637383",
      "extension": "32043",
      "email": "bsalsalem@iau.edu.sa"
    }
  },
  {
    "organization": "كلية علوم الحاسب وتقنية المعلوماتA61 للطالبات",
    "label": "كلية علوم الحاسب وتقنية المعلومات A61",
    "buildingCode": "A61",
    "women": 1,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.مشاعل بن عيسى بوبشيت",
      "jobTitle": "سكرتيرة",
      "mobile": "0551084364",
      "extension": "32080",
      "email": "meabubshait@iau.edu.sa"
    }
  },
  {
    "organization": "عمادة تطوير التعليم الجامعي",
    "label": "عمادة تطوير التعليم الجامعي",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.يوسف أحمد المسبح",
      "jobTitle": "سكرتير ممارس",
      "mobile": "0506817789",
      "extension": null,
      "email": "yalmosabih@iau.edu.sa"
    }
  },
  {
    "organization": "كلية التصاميم",
    "label": "كلية التصاميم",
    "buildingCode": null,
    "women": 2,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.ابتسام الجندان",
      "jobTitle": "مديرة الشؤون الاداريه والماليه بكلية التصاميم",
      "mobile": "0504839985",
      "extension": "31949",
      "email": "ejindan@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الآداب",
    "label": "كلية الآداب",
    "buildingCode": null,
    "women": 2,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.بدور نافع الحربي",
      "jobTitle": "مساعد اداري",
      "mobile": "0506197430",
      "extension": "38327",
      "email": "Bnalharbi@iau.edu.sa"
    }
  },
  {
    "organization": "كلية العلوم الطبية التطبيقية",
    "label": "كلية العلوم الطبية التطبيقية",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.محمد ناصر الصيعري",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0555273222",
      "extension": "35240",
      "email": "mnalsayeari@iau.edu.sa"
    }
  },
  {
    "organization": "كلية طب الأسنان",
    "label": "كلية طب الأسنان",
    "buildingCode": null,
    "women": 1,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.أماني الجاسم",
      "jobTitle": "مساعد إداري",
      "mobile": "0509752952",
      "extension": "31496",
      "email": "ahaljassim@iau.edu.sa"
    }
  },
  {
    "organization": "مستشفى طب الأسنان الجامعي",
    "label": "مستشفى طب الأسنان الجامعي",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.عبدالله السروج",
      "jobTitle": "مساعد إداري",
      "mobile": "0544399392",
      "extension": "31409",
      "email": "aaaalsuruj@iau.edu.sa"
    }
  },
  {
    "organization": "كلية إدارة الأعمال",
    "label": "كلية إدارة الأعمال",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.عبدالعزيز بن عبدالرحمن العمرو",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0502343534",
      "extension": "32064",
      "email": "aaamro@iau.edu.sa"
    }
  },
  {
    "organization": "الكلية التطبيقية",
    "label": "الكلية التطبيقية - عبدالله فؤاد",
    "buildingCode": null,
    "women": 3,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.شيماء جاسم الضعيان",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0558243214",
      "extension": "38982",
      "email": "sjaldayyan@iau.edu.sa"
    }
  },
  {
    "organization": "وكالة عمادة شؤون الطلبة للطالبات-مصلى العلوم",
    "label": "العلوم",
    "buildingCode": null,
    "women": 1,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.حنان علي القحطاني",
      "jobTitle": "ممارس إداري ثالث",
      "mobile": "0545564649",
      "extension": "37117",
      "email": "haqahtani@iau.edu.sa"
    }
  },
  {
    "organization": "كلية التربية",
    "label": "كلية التربية",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.روان يوسف اليوسف",
      "jobTitle": "منسقة الأنشطة ومشرفة الخدمات العامة",
      "mobile": "0530994693",
      "extension": "37152",
      "email": "ryalyosef@iau.edu.sa"
    }
  },
  {
    "organization": "كلية التمريض",
    "label": "كلية التمريض",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.سليمان عبد الله  العريني",
      "jobTitle": "ناسخ",
      "mobile": "0542920770",
      "extension": "31599",
      "email": "sahaloraini@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الهندسة الحرم الشرقي-A13",
    "label": "كلية الهندسة A13",
    "buildingCode": "A13",
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.أحمد توفيق الغنيم",
      "jobTitle": "مساعد مدير الإدارة",
      "mobile": "0564179826",
      "extension": "31724",
      "email": "atalghunaim@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الهندسة الحرم الشرقي-A14",
    "label": "كلية الهندسة A14",
    "buildingCode": "A14",
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.خالد بن يوسف الرويجح",
      "jobTitle": "رئيس وحدة المعامل",
      "mobile": "0505545075",
      "extension": "31200",
      "email": "kalruwaijeh@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الهندسة الحرم الغربي-A46",
    "label": "كلية الهندسة A46",
    "buildingCode": "A46",
    "women": 1,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.إلهام بنت فهد المغلوث",
      "jobTitle": "مساعدة مدير الإدارة بأقسام الطالبات",
      "mobile": "0504999315",
      "extension": "31727",
      "email": "efalmaghlouth@iau.edu.sa"
    }
  },
  {
    "organization": "كلية العلوم الطبية التطبيقية بالجبيل",
    "label": "كلية العلوم الطبية التطبيقية بالجبيل",
    "buildingCode": null,
    "women": 1,
    "men": 0,
    "city": "الجبيل",
    "coordinator": {
      "name": "أ.نجاة عشوى المطرفي",
      "jobTitle": "أخصائية قبول وتسجيل",
      "mobile": "0504455658",
      "extension": "38725",
      "email": "nalmatrafi@iau.edu.sa"
    }
  },
  {
    "organization": "عمادة التعليم الإلكتروني والتعلم عن بعد",
    "label": "عمادة التعليم الإلكتروني والتعلم عن بعد",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.محمد بن راشد الرشداني",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0504988343",
      "extension": "32460",
      "email": "mralrashdani@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الطب",
    "label": "كلية الطب",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.أحمد محمد العجمة",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0503772494",
      "extension": "31146",
      "email": "aalajmah@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الصيدلة",
    "label": "كلية الصيدلة",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.هشام الخضيري",
      "jobTitle": "مسجل معلومات",
      "mobile": "0505981777",
      "extension": "31345",
      "email": "halkodery@iau.edu.sa"
    }
  },
  {
    "organization": "عمادة السنة التحضيرية والدراسات المساندة (طلاب)A42",
    "label": "السنة التحضيرية والدراسات المساندة A42",
    "buildingCode": "A42",
    "women": 0,
    "men": 2,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.سالم حمد العنيزان",
      "jobTitle": "مدير الشؤن الإدارية والمالية",
      "mobile": "0552960686",
      "extension": "32604",
      "email": "shalonizan@iau.edu.sa"
    }
  },
  {
    "organization": "عمادة السنة التحضيرية والدراسات المساندة (طالبات)2",
    "label": "السنة التحضيرية والدراسات المساندة - طالبات",
    "buildingCode": null,
    "women": 2,
    "men": 0,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.نورة عيسى الدوسري",
      "jobTitle": "مساعد إداري",
      "mobile": "0537775726",
      "extension": "32649",
      "email": "nealdossary@iau.edu.sa"
    }
  },
  {
    "organization": "كلية الشريعة والقانون",
    "label": "كلية الشريعة والقانون",
    "buildingCode": null,
    "women": 1,
    "men": 2,
    "city": "الدمام",
    "coordinator": {
      "name": "أ.عبدالرحمن بن عبدالعزيز النعيمي",
      "jobTitle": "مدير الشؤون الإدارية والمالية",
      "mobile": "0591191991",
      "extension": "35361",
      "email": "aaalnaimi@iau.edu.sa"
    }
  },
  {
    "organization": "الحركة",
    "label": "الحركة",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام"
  },
  {
    "organization": "كلية التربية - طلاب",
    "label": "كلية التربية - طلاب",
    "buildingCode": null,
    "women": 0,
    "men": 1,
    "city": "الدمام",
    "coordinator": {
      "name": "ماجد عاشور",
      "jobTitle": null,
      "mobile": null,
      "extension": null,
      "email": null
    }
  },
  {
    "organization": "مبنى طب الأسرة",
    "label": "مبنى طب الأسرة",
    "buildingCode": null,
    "women": 1,
    "men": 1,
    "city": "الدمام"
  }
];

const buildCoordinatorNote = (coordinator) => {
  if (!coordinator?.name) return null;
  return [
    `منسق الوحدة بالمبنى: ${coordinator.name}`,
    coordinator.jobTitle ? `المسمى الوظيفي: ${coordinator.jobTitle}` : null,
    coordinator.mobile ? `الجوال: ${coordinator.mobile}` : null,
    coordinator.extension ? `التحويلة: ${coordinator.extension}` : null,
    coordinator.email ? `البريد الإلكتروني: ${coordinator.email}` : null,
  ].filter(Boolean).join(' — ');
};

const buildPrayerRoomSites = () => PRAYER_ROOM_INVENTORY.flatMap((item) => {
  const rows = [];
  const campusBase = item.buildingCode
    ? `${item.buildingCode} — ${item.organization}`
    : item.organization;
  const coordinatorNote = buildCoordinatorNote(item.coordinator);

  const addRooms = (count, genderLabel) => {
    for (let index = 1; index <= count; index += 1) {
      const sequence = count > 1 ? ` ${index}` : '';
      rows.push({
        name: `مصلى ${item.label} - ${genderLabel}${sequence}`,
        siteType: 'prayer_room',
        prayerRoomGender: genderLabel === 'نساء' ? 'women' : 'men',
        city: item.city,
        district: item.organization,
        campusLocation: `${campusBase} — ${genderLabel}${count > 1 ? ` — مصلى رقم ${index}` : ''}`,
        status: 'active',
        contactPhone: item.coordinator?.mobile || null,
        notes: [
          'بيانات حصر المصليات الجامعية المستخرجة من ملف منسقي وحدة العناية بالمساجد والمصليات داخل مباني الجامعة.',
          `الفئة: مصلى ${genderLabel}.`,
          count > 1 ? `عدد المصليات من نفس الفئة في الجهة: ${count}.` : null,
          coordinatorNote,
        ].filter(Boolean).join(' '),
      });
    }
  };

  addRooms(item.women || 0, 'نساء');
  addRooms(item.men || 0, 'رجال');
  return rows;
});

export const OFFICIAL_MOSQUE_SITES = [
  {
    name: 'مسجد 1',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M1 — مقابل مبنى A4',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M1.',
  },
  {
    name: 'مسجد 2',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M4 — بجانب السكن الطلابي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M4.',
  },
  {
    name: 'مسجد 3',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشرقي C1',
    campusLocation: 'M5 — بالقرب من سكن أعضاء هيئة التدريس',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M5.',
  },
  {
    name: 'مسجد 4',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الغربي C1',
    campusLocation: 'M21 — مقابل مبنى كلية الهندسة A46',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M21.',
  },
  {
    name: 'مسجد 5',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الغربي C1',
    campusLocation: 'M25 — مقابل مبنى المستشفى الرئيسي H1',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M25.',
  },
  {
    name: 'مسجد 6',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشمالي C1',
    campusLocation: 'M28 — بالحرم الشمالي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M28.',
  },
  {
    name: 'مسجد 7',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الحرم الشمالي C1',
    campusLocation: 'M33 — بالجهة السكنية بالحرم الشمالي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M33.',
  },
  {
    name: 'مصلى 1',
    siteType: 'prayer_room',
    city: 'الدمام',
    district: 'حرم الريان C2',
    campusLocation: 'M52 — بالحرم الجامعي بالريان',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M52.',
  },
  {
    name: 'مصلى 2',
    siteType: 'prayer_room',
    city: 'الدمام',
    district: 'حرم الريان C2',
    campusLocation: 'M53 — بالحرم الجامعي بالريان',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M53.',
  },
  {
    name: 'مسجد 8',
    siteType: 'mosque',
    city: 'الدمام',
    district: 'الكلية التطبيقية (عبدالله فؤاد) C5',
    campusLocation: 'M65 — بحرم الكلية التطبيقية بحي عبدالله فؤاد',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M65.',
  },
  {
    name: 'مسجد 9',
    siteType: 'mosque',
    city: 'الخبر',
    district: 'مستشفى الملك فهد الجامعي C6',
    campusLocation: 'M71 — بمستشفى الملك فهد الجامعي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M71.',
  },
  {
    name: 'مسجد 10',
    siteType: 'mosque',
    city: 'الخبر',
    district: 'مستشفى الملك فهد الجامعي C6',
    campusLocation: 'M72 — بالمجمع السكني التابع لمستشفى الملك فهد الجامعي',
    status: 'active',
    notes: 'بيانات الحصر الرسمي للمساجد والمصليات الجامعية — رقم المبنى M72.',
  },
  ...buildPrayerRoomSites(),
];

export async function ensureOfficialMosqueSites() {
  const names = OFFICIAL_MOSQUE_SITES.map((site) => site.name);
  const existing = await prisma.mosqueSite.findMany({
    where: { name: { in: names } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((site) => site.name));
  const missing = OFFICIAL_MOSQUE_SITES.filter((site) => !existingNames.has(site.name));

  if (missing.length) {
    await prisma.$transaction(
      missing.map((site) => prisma.mosqueSite.create({ data: site }))
    );
  }

  const genderBackfills = OFFICIAL_MOSQUE_SITES.filter((site) => site.siteType === 'prayer_room' && site.prayerRoomGender);
  if (genderBackfills.length) {
    await prisma.$transaction(
      genderBackfills.map((site) => prisma.mosqueSite.updateMany({
        where: { name: site.name, prayerRoomGender: null },
        data: { prayerRoomGender: site.prayerRoomGender },
      }))
    );
  }

  console.log(`Official mosque/prayer-room sites ensured: ${missing.length} created, ${genderBackfills.length} gender records checked, ${OFFICIAL_MOSQUE_SITES.length} total.`);
  return { created: missing.length, genderChecked: genderBackfills.length, total: OFFICIAL_MOSQUE_SITES.length };
}
