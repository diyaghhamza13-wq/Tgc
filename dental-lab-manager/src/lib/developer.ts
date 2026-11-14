import type { Lang } from './i18n';

/** "About the developer" content, from https://hamzadiyagh.com */
export const DEVELOPER = {
  name: 'Hamza Diyagh',
  website: 'https://hamzadiyagh.com',
  email: 'diyaghhamza13@gmail.com',
  whatsapp: '+39 352 228 6947',
  whatsappUrl: 'https://wa.me/393522286947',
  linkedin: 'https://www.linkedin.com/in/hamza-diyagh-3bb962174/',
  software: ['Exocad', '3Shape Dental System', '3Shape Implant Studio', 'Blender for Dental', 'PartialCAD', 'RealGUIDE', 'coDiagnostiX', 'SimPlant', 'Exoplan', 'Zirkonzahn', 'BlueSkyPlan', 'Asiga Composer'],
  machines: ['Roland DWX-52D', 'Roland DWX-51D', 'Ivoclar PrograMill PM7', 'Yena D15', 'CoriTec 5-Axis', 'Asiga MAX', 'SprintRay', 'Formlabs'],
  education: [
    { school: 'Faculté de Médecine Dentaire de Rabat', field: 'Dental Technology' },
    { school: 'The University of Hong Kong', field: 'Implant Dentistry' },
  ],
  certifications: [
    { title: 'Ceramic Layering Techniques', org: 'VITA North America', date: '2023' },
    { title: 'Personalized “Biomimetic” Ceramic Layering Technique', org: 'Master Nawfal Bendahmane', date: '' },
    { title: 'Implant Dentistry', org: 'The University of Hong Kong', date: '2023' },
    { title: 'Materials in Oral Health', org: 'The University of Hong Kong', date: '2023' },
    { title: 'Frontiers in Dentistry', org: 'University of Pennsylvania', date: '' },
    { title: 'Ceramics and Composites', org: 'Arizona State University', date: '' },
    { title: 'Certificate of Excellence', org: 'Dental Success', date: '2024' },
  ],
};

type Text = {
  pageTitle: string;
  madeBy: string;
  titles: string[];
  tagline: string;
  aboutTitle: string;
  about: string[];
  expertiseTitle: string;
  expertise: { title: string; text: string }[];
  toolsTitle: string;
  software: string;
  machines: string;
  educationTitle: string;
  certTitle: string;
  contactTitle: string;
  contactText: string;
  website: string;
  footer: string;
};

export const DEV_TEXT: Record<Lang, Text> = {
  en: {
    pageTitle: 'About the developer',
    madeBy: 'Designed & developed by',
    titles: ['Master Digital Dental Technician', 'Maxillofacial Prosthetics Specialist', 'CEO & Founder — Harmonious Zenith Dentistry'],
    tagline: 'Precision meets artistry',
    aboutTitle: 'About me',
    about: [
      'I am Hamza Diyagh, a Master Digital Dental Technician focused on CAD/CAM technology, implant prosthetics, fixed restorations and aesthetic dentistry.',
      'My approach combines digital design, anatomical understanding and attention to detail to support high-quality dental laboratory workflows, from initial planning to production. Dental Lab Manager grew out of that daily laboratory experience.',
    ],
    expertiseTitle: 'What I do',
    expertise: [
      { title: 'Digital Dentistry', text: 'Digital dental workflows, precise CAD design and modern laboratory solutions.' },
      { title: 'Implant Prosthetics', text: 'Custom abutments, hybrid restorations, implant bars and implant-supported prosthetics.' },
      { title: 'Fixed Prosthetics', text: 'Crowns, bridges, veneers, inlays, onlays and highly aesthetic restorations.' },
      { title: 'Surgical Guides', text: 'Digital implant planning and surgical guide design for predictable workflows.' },
      { title: 'Dental Ceramics', text: 'Anatomy, morphology, surface texture, shade and natural aesthetics.' },
      { title: 'CAD/CAM Production', text: 'Digital preparation for milling and 3D printing with different dental materials.' },
    ],
    toolsTitle: 'Tools behind the precision',
    software: 'Software',
    machines: 'Machines',
    educationTitle: 'Education',
    certTitle: 'Courses & certifications',
    contactTitle: "Let's connect",
    contactText: 'Interested in digital dentistry, CAD/CAM collaboration or a custom version of this app for your laboratory? Get in touch.',
    website: 'Website',
    footer: '© 2026 Hamza Diyagh · Dental Lab Manager',
  },
  ar: {
    pageTitle: 'حول صانع التطبيق',
    madeBy: 'تصميم وتطوير',
    titles: ['تقني أسنان رقمي خبير (Master)', 'متخصص في تعويضات الوجه والفكين', 'المؤسس والمدير العام — Harmonious Zenith Dentistry'],
    tagline: 'حيث تلتقي الدقة بالفن',
    aboutTitle: 'من أنا',
    about: [
      'أنا حمزة دياغ، تقني أسنان رقمي خبير، متخصص في تقنية CAD/CAM، وتعويضات الزرعات، والتعويضات الثابتة، وطب الأسنان التجميلي.',
      'أجمع بين التصميم الرقمي والفهم التشريحي والاهتمام بأدق التفاصيل، لدعم سير عمل مختبرات الأسنان بجودة عالية من التخطيط حتى الإنتاج. ومن هذه التجربة اليومية في المختبر وُلد تطبيق Dental Lab Manager.',
    ],
    expertiseTitle: 'مجالات عملي',
    expertise: [
      { title: 'طب الأسنان الرقمي', text: 'سير عمل رقمي، وتصميم CAD دقيق، وحلول حديثة للمختبرات.' },
      { title: 'تعويضات الزرعات', text: 'دعامات مخصصة، تعويضات هجينة، قضبان زرعات، وتعويضات محمولة على الزرعات.' },
      { title: 'التعويضات الثابتة', text: 'تيجان، جسور، قشور، حشوات Inlay وOnlay، وتعويضات تجميلية عالية الجودة.' },
      { title: 'الأدلة الجراحية', text: 'تخطيط رقمي للزرعات وتصميم أدلة جراحية لنتائج مضمونة.' },
      { title: 'خزف الأسنان', text: 'التشريح، الشكل، ملمس السطح، اللون، والجمال الطبيعي.' },
      { title: 'إنتاج CAD/CAM', text: 'تحضير رقمي للتفريز والطباعة ثلاثية الأبعاد بمواد مختلفة.' },
    ],
    toolsTitle: 'الأدوات التي أعمل بها',
    software: 'البرامج',
    machines: 'الآلات',
    educationTitle: 'التكوين الأكاديمي',
    certTitle: 'الدورات والشهادات',
    contactTitle: 'تواصل معي',
    contactText: 'مهتم بطب الأسنان الرقمي، أو تعاون في CAD/CAM، أو نسخة مخصصة من هذا التطبيق لمختبرك؟ تواصل معي.',
    website: 'الموقع',
    footer: '© 2026 حمزة دياغ · Dental Lab Manager',
  },
  fr: {
    pageTitle: 'À propos du créateur',
    madeBy: 'Conçu et développé par',
    titles: ['Master Prothésiste Dentaire Numérique', 'Spécialiste en prothèse maxillo-faciale', 'CEO & Fondateur — Harmonious Zenith Dentistry'],
    tagline: 'Quand la précision rencontre l’art',
    aboutTitle: 'À propos',
    about: [
      'Je suis Hamza Diyagh, Master Prothésiste Dentaire Numérique, spécialisé en CAO/FAO, prothèse sur implants, prothèse fixe et dentisterie esthétique.',
      'Mon approche associe conception numérique, compréhension anatomique et souci du détail pour accompagner des flux de travail de laboratoire de haute qualité, de la planification à la production. Dental Lab Manager est né de cette expérience quotidienne au laboratoire.',
    ],
    expertiseTitle: 'Mes domaines',
    expertise: [
      { title: 'Dentisterie numérique', text: 'Flux numériques, conception CAO précise et solutions modernes de laboratoire.' },
      { title: 'Prothèse sur implants', text: 'Piliers personnalisés, restaurations hybrides, barres et prothèses implanto-portées.' },
      { title: 'Prothèse fixe', text: 'Couronnes, bridges, facettes, inlays, onlays et restaurations esthétiques.' },
      { title: 'Guides chirurgicaux', text: 'Planification implantaire numérique et conception de guides chirurgicaux.' },
      { title: 'Céramique dentaire', text: 'Anatomie, morphologie, état de surface, teinte et esthétique naturelle.' },
      { title: 'Production CFAO', text: 'Préparation numérique pour l’usinage et l’impression 3D de différents matériaux.' },
    ],
    toolsTitle: 'Les outils de la précision',
    software: 'Logiciels',
    machines: 'Machines',
    educationTitle: 'Formation',
    certTitle: 'Cours & certifications',
    contactTitle: 'Restons en contact',
    contactText: 'Dentisterie numérique, collaboration CFAO ou version personnalisée de cette application pour votre laboratoire ? Contactez-moi.',
    website: 'Site web',
    footer: '© 2026 Hamza Diyagh · Dental Lab Manager',
  },
};
