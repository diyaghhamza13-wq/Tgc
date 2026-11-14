import type { Lang } from './i18n';

/**
 * Privacy policy shown at /privacy (linked from the stores).
 * Describes what the app actually does; keep it in sync with the code.
 */
export const PRIVACY_UPDATED = '2026-11-07';
export const PRIVACY_CONTACT = 'diyaghhamza13@gmail.com';

type Section = { h: string; p: string[] };
export const PRIVACY: Record<Lang, { title: string; updated: string; intro: string; sections: Section[] }> = {
  en: {
    title: 'Privacy Policy',
    updated: 'Last updated',
    intro:
      'Dental Lab Manager is a management application for dental laboratories, developed by Hamza Diyagh. This policy explains which data the app processes, why, and what rights you have.',
    sections: [
      { h: '1. Who is responsible', p: [
        'Each laboratory that registers in the app decides which data it enters about its employees, clients and patients, and is responsible for that data (data controller).',
        'Hamza Diyagh provides and operates the application and processes this data only on behalf of the laboratories, to provide the service (data processor). Contact: ' + PRIVACY_CONTACT + '.',
      ] },
      { h: '2. Data we process', p: [
        'Laboratory: name, code, contact details, address and logo.',
        'Employees: full name, employee code, department, role, specialty, optional phone, email and profile photo, last login time. PINs are never stored in readable form: only a one-way bcrypt hash is kept.',
        'Doctors / clients: name, clinic and contact details entered by the laboratory.',
        'Cases: patient name and optional reference, prescription details (teeth, restorations, materials, implant information, shade, notes), production history, quality-control results, delivery records and attached files (scans, images, PDF prescriptions).',
        'Technical data: security and audit logs of actions performed in the app (who did what and when).',
      ] },
      { h: '3. Why we use it', p: [
        'Only to provide the service: managing dental cases, coordinating production between employees, notifications, reports, and keeping the laboratory secure.',
        'We do not sell data, do not show advertising, do not use third-party analytics or tracking, and do not use the data for any other purpose.',
      ] },
      { h: '4. Where data is stored and who can see it', p: [
        'Data is stored with Supabase (database, authentication and file storage) in the EU-West-2 (London) region, and the web version is served by Netlify.',
        'Each laboratory\'s data is isolated: employees of one laboratory can never access another laboratory\'s data. Inside a laboratory, access depends on each employee\'s role and permissions. Files are private and can only be opened by authorised employees through temporary links.',
        'All connections are encrypted (HTTPS).',
      ] },
      { h: '5. Health data', p: [
        'Patient names and prescription details can be health-related data. Laboratories must only enter the data they need for the work, and must have a lawful basis to process it under the laws that apply to them (for example the GDPR in Europe or law 09-08 in Morocco).',
      ] },
      { h: '6. How long data is kept', p: [
        'Data is kept as long as the laboratory uses the service. An employee can delete their own account at any time (Profile → Delete my account). A laboratory administrator can delete the whole laboratory and all its data, including files and accounts (Lab profile → Delete this laboratory). Deletion is permanent.',
      ] },
      { h: '7. Your rights', p: [
        'You can ask to access, correct or delete your personal data. Employees can do this through their laboratory administrator or directly in the app; patients and doctors should contact the laboratory that holds their data. You can also write to ' + PRIVACY_CONTACT + '.',
      ] },
      { h: '8. Children', p: ['The app is intended for professionals and is not directed at children.'] },
      { h: '9. Changes', p: ['If this policy changes, the new version is published on this page with its update date.'] },
    ],
  },
  ar: {
    title: 'سياسة الخصوصية',
    updated: 'آخر تحديث',
    intro: 'Dental Lab Manager تطبيق لإدارة مختبرات الأسنان، طوّره حمزة دياغ. تشرح هذه السياسة البيانات التي يعالجها التطبيق، ولماذا، وما هي حقوقك.',
    sections: [
      { h: '١. المسؤول عن البيانات', p: [
        'كل مختبر يسجّل في التطبيق هو من يقرر البيانات التي يُدخلها عن عماله وعملائه ومرضاه، وهو المسؤول عنها.',
        'حمزة دياغ يوفّر التطبيق ويشغّله، ويعالج هذه البيانات فقط نيابةً عن المختبرات ولتقديم الخدمة. للتواصل: ' + PRIVACY_CONTACT + '.',
      ] },
      { h: '٢. البيانات التي نعالجها', p: [
        'المختبر: الاسم، الكود، معلومات الاتصال، العنوان والشعار.',
        'العمال: الاسم الكامل، كود العامل، القسم، الدور، التخصص، والهاتف والبريد والصورة اختياريًا، ووقت آخر دخول. الرموز السرية (PIN) لا تُخزّن أبدًا بشكل مقروء، بل تُحفظ مشفّرة تشفيرًا لا يمكن عكسه (bcrypt).',
        'الأطباء / العملاء: الاسم، العيادة ومعلومات الاتصال التي يُدخلها المختبر.',
        'الطلبات: اسم المريض ومرجع اختياري، وتفاصيل الوصفة (الأسنان، التعويضات، المواد، معلومات الزرعات، اللون، الملاحظات)، وسجل الإنتاج، ونتائج مراقبة الجودة، وسجلات التسليم، والملفات المرفقة (ملفات المسح، الصور، وصفات PDF).',
        'بيانات تقنية: سجلات الأمان والتدقيق للعمليات داخل التطبيق (من فعل ماذا ومتى).',
      ] },
      { h: '٣. لماذا نستعملها', p: [
        'فقط لتقديم الخدمة: إدارة طلبات الأسنان، تنسيق الإنتاج بين العمال، الإشعارات، التقارير، وحماية المختبر.',
        'لا نبيع البيانات، ولا نعرض إعلانات، ولا نستعمل أدوات تحليل أو تتبّع من جهات خارجية، ولا نستعمل البيانات لأي غرض آخر.',
      ] },
      { h: '٤. أين تُخزَّن البيانات ومن يراها', p: [
        'تُخزَّن البيانات لدى Supabase (قاعدة البيانات، تسجيل الدخول وتخزين الملفات) في منطقة EU-West-2 (لندن)، ونسخة الويب مستضافة على Netlify.',
        'بيانات كل مختبر معزولة تمامًا: لا يستطيع عمال مختبر الوصول إلى بيانات مختبر آخر أبدًا. وداخل المختبر، يتحدد الوصول حسب دور وصلاحيات كل عامل. الملفات خاصة ولا يفتحها إلا العمال المخوّلون عبر روابط مؤقتة.',
        'كل الاتصالات مشفّرة (HTTPS).',
      ] },
      { h: '٥. البيانات الصحية', p: [
        'أسماء المرضى وتفاصيل الوصفات قد تُعتبر بيانات صحية. على المختبرات إدخال ما تحتاجه للعمل فقط، وأن يكون لها أساس قانوني لمعالجتها وفق القوانين المطبّقة عليها (مثل القانون 09-08 في المغرب أو اللائحة الأوروبية GDPR).',
      ] },
      { h: '٦. مدة الاحتفاظ', p: [
        'تُحفظ البيانات ما دام المختبر يستعمل الخدمة. يستطيع العامل حذف حسابه في أي وقت (ملفي الشخصي ← حذف حسابي). ويستطيع مدير المختبر حذف المختبر بالكامل مع كل بياناته وملفاته وحساباته (ملف المختبر ← حذف هذا المختبر). الحذف نهائي.',
      ] },
      { h: '٧. حقوقك', p: [
        'يمكنك طلب الاطلاع على بياناتك الشخصية أو تصحيحها أو حذفها. يستطيع العمال فعل ذلك عبر مدير المختبر أو مباشرة من التطبيق، أما المرضى والأطباء فيتواصلون مع المختبر الذي يحتفظ ببياناتهم. ويمكنك أيضًا المراسلة على ' + PRIVACY_CONTACT + '.',
      ] },
      { h: '٨. الأطفال', p: ['التطبيق موجّه للمهنيين وليس للأطفال.'] },
      { h: '٩. التعديلات', p: ['إذا تغيّرت هذه السياسة، تُنشر النسخة الجديدة في هذه الصفحة مع تاريخ التحديث.'] },
    ],
  },
  fr: {
    title: 'Politique de confidentialité',
    updated: 'Dernière mise à jour',
    intro: "Dental Lab Manager est une application de gestion pour laboratoires de prothèse dentaire, développée par Hamza Diyagh. Cette politique explique quelles données l'application traite, pourquoi, et quels sont vos droits.",
    sections: [
      { h: '1. Responsable du traitement', p: [
        "Chaque laboratoire inscrit décide des données qu'il saisit sur ses employés, clients et patients, et en est responsable (responsable du traitement).",
        "Hamza Diyagh fournit et exploite l'application et traite ces données uniquement pour le compte des laboratoires, afin de fournir le service (sous-traitant). Contact : " + PRIVACY_CONTACT + '.',
      ] },
      { h: '2. Données traitées', p: [
        'Laboratoire : nom, code, coordonnées, adresse et logo.',
        "Employés : nom complet, code employé, service, rôle, spécialité, téléphone, e-mail et photo facultatifs, date de dernière connexion. Les codes PIN ne sont jamais stockés en clair : seul un hachage bcrypt irréversible est conservé.",
        'Médecins / clients : nom, cabinet et coordonnées saisis par le laboratoire.',
        'Cas : nom du patient et référence facultative, détails de la prescription (dents, restaurations, matériaux, informations implantaires, teinte, notes), historique de production, résultats du contrôle qualité, livraisons et fichiers joints (scans, images, prescriptions PDF).',
        "Données techniques : journaux de sécurité et d'audit des actions effectuées dans l'application.",
      ] },
      { h: '3. Finalités', p: [
        'Uniquement fournir le service : gestion des cas, coordination de la production entre employés, notifications, rapports et sécurité du laboratoire.',
        "Nous ne vendons pas les données, n'affichons pas de publicité, n'utilisons aucun outil d'analyse ou de suivi tiers, et n'utilisons pas les données à d'autres fins.",
      ] },
      { h: '4. Hébergement et accès', p: [
        "Les données sont hébergées chez Supabase (base de données, authentification, stockage de fichiers) dans la région EU-West-2 (Londres) ; la version web est servie par Netlify.",
        "Les données de chaque laboratoire sont isolées : les employés d'un laboratoire ne peuvent jamais accéder aux données d'un autre. Au sein d'un laboratoire, l'accès dépend du rôle et des autorisations de chacun. Les fichiers sont privés et ne s'ouvrent que par des liens temporaires pour les employés autorisés.",
        'Toutes les connexions sont chiffrées (HTTPS).',
      ] },
      { h: '5. Données de santé', p: [
        "Les noms des patients et les prescriptions peuvent constituer des données de santé. Les laboratoires ne doivent saisir que les données nécessaires et disposer d'une base légale pour les traiter selon la loi applicable (RGPD en Europe, loi 09-08 au Maroc).",
      ] },
      { h: '6. Durée de conservation', p: [
        "Les données sont conservées tant que le laboratoire utilise le service. Un employé peut supprimer son compte à tout moment (Mon profil → Supprimer mon compte). L'administrateur peut supprimer tout le laboratoire avec l'ensemble de ses données, fichiers et comptes (Profil du laboratoire → Supprimer ce laboratoire). La suppression est définitive.",
      ] },
      { h: '7. Vos droits', p: [
        "Vous pouvez demander l'accès, la rectification ou la suppression de vos données. Les employés passent par leur administrateur ou directement par l'application ; les patients et médecins s'adressent au laboratoire concerné. Vous pouvez aussi écrire à " + PRIVACY_CONTACT + '.',
      ] },
      { h: '8. Enfants', p: ["L'application est destinée aux professionnels et ne s'adresse pas aux enfants."] },
      { h: '9. Modifications', p: ['Toute nouvelle version de cette politique est publiée sur cette page avec sa date de mise à jour.'] },
    ],
  },
};
