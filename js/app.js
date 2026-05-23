// ===== TECNO_CAJA - MAIN APP =====

let clockTimer = null;
let cajaAbierta = false;
let notificationsSeenCount = 0;
let licenseWatchTimer = null;
let licenseBlockInProgress = false;
const UI_PREFS_KEY = 'tecnocaja-ui-preferences';
const LAST_LOGIN_USER_KEY = 'tecnocaja-last-login-user';
const DEFAULT_LICENSE_WHATSAPP = '18292812877';
let setupState = null;
let pendingGoogleLinkSession = null;
let setupWizard = {
  step: 0,
  language: 'es',
  businessType: 'pizzeria',
  businessStructureMode: 'monocaja',
  forceReset: false,
  securityPassword: '',
  googleAuth: null
};
let loginMode = 'existing';
let loginTransitionLock = false;
let trialBusinessCatalog = [];
let trialBusinessState = {
  active: false,
  preview: null,
  snapshot: null
};
const BASE_UI_TEXT = {
  loginSubtitle: 'Sistema de Punto de Venta Profesional',
  loginUser: 'Usuario',
  loginPass: 'Contraseña',
  loginButton: 'Iniciar Sesión',
  loginGoogleButton: 'Entrar con Google',
  loginGoogleSetupButton: 'Continuar con Google',
  loginHint: 'Ingresa con tu usuario registrado para continuar.',
  loginHintSetupRequired: 'El asistente inicial debe completarse antes de poder iniciar sesión.',
  loginLanguage: 'Idioma',
  loginExisting: 'Ya tengo cuenta',
  loginNew: 'Soy usuario nuevo',
  loginNewTitle: 'Vamos a configurar tu negocio',
  loginNewText: 'Primero elegiremos el idioma, luego definirás el modo de operación, crearás el usuario administrador y completarás la configuración inicial.',
  loginNewAction: 'Comenzar primer inicio',
  loginReinstallAction: 'Reinstalar una app existente',
  setupLogoText: 'Primer Inicio',
  setupSubtitle: 'Configura el negocio una sola vez y deja el sistema listo para trabajar.',
  setupSteps: ['1. Idioma', '2. Operación', '3. Usuario', '4. Datos', '5. Impresión', '6. Caja'],
  setupPanels: [
    {
      title: 'Idioma del sistema',
      text: 'Elige el idioma base que usará el negocio al comenzar.'
    },
    {
      title: 'Modo de operación, negocio y moneda',
      text: 'Define si el sistema trabajará como monocaja, multicaja o multisucursal antes de continuar.'
    },
    {
      title: 'Administrador inicial',
      text: 'Crea el primer administrador. El sistema no permitirá acceso libre y los demás usuarios deberán ser creados por este administrador.'
    },
    {
      title: 'Datos del negocio',
      text: 'Estos datos saldrán en comprobantes, configuración general y reportes.'
    },
    {
      title: 'Impresión y comprobantes',
      text: 'Selecciona cómo vas a imprimir y el tamaño de papel para dejar la caja lista.'
    },
    {
      title: 'Apertura inicial de caja',
      text: 'Abre la caja ahora para entrar al sistema ya listo para cobrar.'
    }
  ],
  setupBack: 'Atrás',
  setupNext: 'Siguiente',
  setupFinish: 'Finalizar e iniciar',
  setupTrialNote: 'La prueba completa quedará activa por 30 días. Luego podrás validar la licencia desde tu app de administrador.',
  setupStructureLabel: 'Estructura de operación',
  setupStructureHelp: 'Elige si trabajarás con una sola caja, varias cajas en una misma sucursal o varias sucursales con sus cajas.',
  setupStructureOptions: [
    {
      value: 'monocaja',
      label: 'Monocaja',
      subtitle: 'Una sola sucursal con una sola caja para una operación simple y controlada.',
      accent: '#0f766e',
      accentLight: '#5eead4'
    },
    {
      value: 'multicaja',
      label: 'Multicaja',
      subtitle: 'Una sola sucursal con varias cajas trabajando sobre la misma base de datos.',
      accent: '#b45309',
      accentLight: '#fbbf24'
    },
    {
      value: 'multisucursal',
      label: 'Multisucursal',
      subtitle: 'Varias sucursales con sus cajas y usuarios administrados desde la misma instalación.',
      accent: '#1d4ed8',
      accentLight: '#60a5fa'
    }
  ],
  setupGoogleLinkedTitle: 'Cuenta Google vinculada',
  setupGoogleLinkedText: 'Usaremos tu nombre y correo de Google para crear la cuenta dueña del negocio. Solo debes definir el usuario administrador y, si quieres, una contraseña local opcional.',
  setupFieldLabels: {
    adminName: 'Nombre completo',
    adminUser: 'Usuario',
    adminEmail: 'Correo',
    adminPass: 'Contraseña',
    currency: 'Moneda',
    businessName: 'Nombre del negocio',
    businessRnc: 'RNC / Cédula',
    businessAddress: 'Dirección',
    businessPhone: 'Teléfono',
    taxRate: 'ITBIS / Impuesto (%)',
    printMode: 'Modo de impresión',
    paperSize: 'Tamaño de papel',
    printer: 'Impresora',
    openingAmount: 'Monto de apertura',
    openingNotes: 'Observaciones'
  },
  setupPlaceholders: {
    adminName: 'Ej: Emilio Pérez',
    adminUser: 'admin',
    adminEmail: 'correo@negocio.com',
    adminPass: 'Mínimo 4 caracteres',
    businessName: 'Mi negocio',
    businessRnc: '000-00000-0',
    businessAddress: 'Calle, sector, ciudad',
    businessPhone: '809-000-0000',
    openingNotes: 'Ej: caja inicial del día, fondo para cambio...'
  },
  setupOptionLabels: {
    printDialog: 'Mostrar diálogo del sistema',
    printDirect: 'Impresión directa',
    paper58: 'Ticket térmico 58mm',
    paper80: 'Ticket térmico 80mm',
    paperA4: 'Carta / A4',
    defaultPrinter: 'Usar impresora predeterminada'
  },
  cashGateTitle: 'Abrir caja para iniciar',
  cashGateCopy: 'Antes de usar el sistema debes registrar la apertura de caja de esta sesión.'
};

function buildUiText(overrides = {}) {
  return { ...BASE_UI_TEXT, ...overrides };
}

const UI_TEXT = {
  es: buildUiText({}),
  en: buildUiText({
    loginSubtitle: 'Professional Point of Sale System',
    loginUser: 'User',
    loginPass: 'Password',
    loginButton: 'Sign In',
    loginGoogleButton: 'Continue with Google',
    loginGoogleSetupButton: 'Continue with Google',
    loginHint: 'Sign in with your registered user to continue.',
    loginHintSetupRequired: 'The initial setup wizard must be completed before anyone can sign in.',
    loginLanguage: 'Language',
    loginExisting: 'I already have an account',
    loginNew: 'I am a new user',
    loginNewTitle: 'Let’s set up your business',
    loginNewText: 'First choose the language, then define the operation mode, create your administrator and complete the initial setup.',
    loginNewAction: 'Start first setup',
    loginReinstallAction: 'Reinstall an existing app',
    setupLogoText: 'First Setup',
    setupSubtitle: 'Configure the business once and leave the system ready to work.',
    setupStructureLabel: 'Operating structure',
    setupStructureHelp: 'Choose whether the system will run with one register, multiple registers in one branch, or multiple branches with their own registers.',
    setupStructureOptions: [
      {
        value: 'monocaja',
        label: 'Single register',
        subtitle: 'One branch with one register for a simple controlled operation.',
        accent: '#0f766e',
        accentLight: '#5eead4'
      },
      {
        value: 'multicaja',
        label: 'Multi-register',
        subtitle: 'One branch with several registers sharing the same database.',
        accent: '#b45309',
        accentLight: '#fbbf24'
      },
      {
        value: 'multisucursal',
        label: 'Multi-branch',
        subtitle: 'Several branches with their own registers managed from the same installation.',
        accent: '#1d4ed8',
        accentLight: '#60a5fa'
      }
    ],
    setupSteps: ['1. Language', '2. Operation', '3. User', '4. Details', '5. Printing', '6. Cash'],
    setupPanels: [
      { title: 'System language', text: 'Choose the main language the business will use from the start.' },
      { title: 'Operation mode, business type and currency', text: 'Define whether the system will run as single register, multi-register or multi-branch before continuing.' },
      { title: 'Initial administrator', text: 'Create the first administrator. The system will not allow free access and the rest of the users must be created later by this administrator.' },
      { title: 'Business details', text: 'These details will appear on receipts, settings and reports.' },
      { title: 'Printing and receipts', text: 'Choose how you will print and the paper size to leave the POS ready.' },
      { title: 'Initial cash opening', text: 'Open the cash register now so you can enter the system ready to charge.' }
    ],
    setupBack: 'Back',
    setupNext: 'Next',
    setupFinish: 'Finish and start',
    setupTrialNote: 'The full trial will remain active for 30 days. Later you can validate the license from your admin app.',
    setupGoogleLinkedTitle: 'Google account linked',
    setupGoogleLinkedText: 'We will use your Google name and email to create the business owner account. You only need to define the admin username and, if you want, an optional local password.',
    setupFieldLabels: {
      adminName: 'Full name',
      adminUser: 'User name',
      adminEmail: 'Email',
      adminPass: 'Password',
      currency: 'Currency',
      businessName: 'Business name',
      businessRnc: 'Tax ID',
      businessAddress: 'Address',
      businessPhone: 'Phone',
      taxRate: 'Tax (%)',
      printMode: 'Print mode',
      paperSize: 'Paper size',
      printer: 'Printer',
      openingAmount: 'Opening amount',
      openingNotes: 'Notes'
    },
    setupPlaceholders: {
      adminName: 'Ex: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@business.com',
      adminPass: 'Minimum 4 characters',
      businessName: 'My business',
      businessRnc: '000-00000-0',
      businessAddress: 'Street, district, city',
      businessPhone: '809-000-0000',
      openingNotes: 'Ex: opening float for today...'
    },
    setupOptionLabels: {
      printDialog: 'Show system dialog',
      printDirect: 'Direct print',
      paper58: '58mm thermal ticket',
      paper80: '80mm thermal ticket',
      paperA4: 'Letter / A4',
      defaultPrinter: 'Use default printer'
    },
    cashGateTitle: 'Open cash register to start',
    cashGateCopy: 'Before using the system, you must register the opening cash amount for this session.'
  }),
  fr: buildUiText({
    loginSubtitle: 'Système professionnel de point de vente',
    loginUser: 'Utilisateur',
    loginPass: 'Mot de passe',
    loginButton: 'Se connecter',
    loginHint: 'Connectez-vous avec votre utilisateur enregistré pour continuer.',
    loginHintSetupRequired: 'Choisissez "Je suis un nouvel utilisateur" pour créer le premier compte et terminer la configuration initiale.',
    loginLanguage: 'Langue',
    loginExisting: 'J’ai déjà un compte',
    loginNew: 'Je suis un nouvel utilisateur',
    loginNewTitle: 'Configurons votre activité',
    loginNewText: 'Choisissez d’abord la langue, puis créez l’utilisateur administrateur et complétez le type d’activité, la devise, l’imprimante et la caisse initiale.',
    loginNewAction: 'Démarrer la première configuration',
    loginReinstallAction: 'Réinstaller une application existante',
    setupLogoText: 'Premier démarrage',
    setupSubtitle: 'Configurez l’activité une seule fois et laissez le système prêt à fonctionner.',
    setupSteps: ['1. Langue', '2. Utilisateur', '3. Activité', '4. Données', '5. Impression', '6. Caisse'],
    setupPanels: [
      { title: 'Langue du système', text: 'Choisissez la langue principale utilisée par l’activité.' },
      { title: 'Administrateur initial', text: 'Cet utilisateur aura un accès complet et un essai complet de 30 jours.' },
      { title: 'Type d’activité et devise', text: 'Cela adapte l’application au type d’activité et à sa structure de base.' },
      { title: 'Données de l’activité', text: 'Ces données apparaîtront sur les reçus, la configuration et les rapports.' },
      { title: 'Impression et reçus', text: 'Choisissez le mode d’impression et le format de papier pour laisser la caisse prête.' },
      { title: 'Ouverture initiale de caisse', text: 'Ouvrez la caisse maintenant pour entrer dans le système prêt à encaisser.' }
    ],
    setupBack: 'Retour',
    setupNext: 'Suivant',
    setupFinish: 'Terminer et démarrer',
    setupTrialNote: 'L’essai complet restera actif pendant 30 jours. Ensuite, vous pourrez valider la licence depuis votre application administrateur.',
    setupFieldLabels: {
      adminName: 'Nom complet',
      adminUser: 'Utilisateur',
      adminEmail: 'E-mail',
      adminPass: 'Mot de passe',
      currency: 'Devise',
      businessName: 'Nom de l’activité',
      businessRnc: 'Identifiant fiscal',
      businessAddress: 'Adresse',
      businessPhone: 'Téléphone',
      taxRate: 'Taxe (%)',
      printMode: 'Mode d’impression',
      paperSize: 'Format papier',
      printer: 'Imprimante',
      openingAmount: 'Montant d’ouverture',
      openingNotes: 'Observations'
    },
    setupPlaceholders: {
      adminName: 'Ex : Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@activite.com',
      adminPass: 'Minimum 4 caractères',
      businessName: 'Mon activité',
      businessRnc: '000-00000-0',
      businessAddress: 'Rue, secteur, ville',
      businessPhone: '809-000-0000',
      openingNotes: 'Ex : fonds de caisse initial...'
    },
    setupOptionLabels: {
      printDialog: 'Afficher la boîte système',
      printDirect: 'Impression directe',
      paper58: 'Ticket thermique 58mm',
      paper80: 'Ticket thermique 80mm',
      paperA4: 'Lettre / A4',
      defaultPrinter: 'Utiliser l’imprimante par défaut'
    },
    cashGateTitle: 'Ouvrir la caisse pour démarrer',
    cashGateCopy: 'Avant d’utiliser le système, vous devez enregistrer l’ouverture de caisse de cette session.'
  }),
  pt: buildUiText({
    loginSubtitle: 'Sistema profissional de ponto de venda',
    loginUser: 'Usuário',
    loginPass: 'Senha',
    loginButton: 'Entrar',
    loginHint: 'Entre com seu usuário cadastrado para continuar.',
    loginHintSetupRequired: 'Escolha "Sou um usuário novo" para criar a primeira conta e terminar a configuração inicial.',
    loginLanguage: 'Idioma',
    loginExisting: 'Já tenho conta',
    loginNew: 'Sou um usuário novo',
    loginNewTitle: 'Vamos configurar seu negócio',
    loginNewText: 'Primeiro escolhemos o idioma, depois você cria o usuário administrador e completa tipo de negócio, moeda, impressora e caixa inicial.',
    loginNewAction: 'Começar primeira configuração',
    loginReinstallAction: 'Reinstalar um aplicativo existente',
    setupLogoText: 'Primeiro início',
    setupSubtitle: 'Configure o negócio uma única vez e deixe o sistema pronto para trabalhar.',
    setupSteps: ['1. Idioma', '2. Usuário', '3. Negócio', '4. Dados', '5. Impressão', '6. Caixa'],
    setupPanels: [
      { title: 'Idioma do sistema', text: 'Escolha o idioma principal que o negócio vai usar desde o início.' },
      { title: 'Administrador inicial', text: 'Este usuário terá acesso completo e 30 dias de teste total.' },
      { title: 'Tipo de negócio e moeda', text: 'Isso adapta o app ao negócio e à sua estrutura base.' },
      { title: 'Dados do negócio', text: 'Esses dados sairão nos comprovantes, configurações e relatórios.' },
      { title: 'Impressão e comprovantes', text: 'Selecione como vai imprimir e o tamanho do papel para deixar o caixa pronto.' },
      { title: 'Abertura inicial do caixa', text: 'Abra o caixa agora para entrar no sistema já pronto para cobrar.' }
    ],
    setupBack: 'Voltar',
    setupNext: 'Seguinte',
    setupFinish: 'Finalizar e iniciar',
    setupTrialNote: 'O teste completo ficará ativo por 30 dias. Depois você poderá validar a licença no seu app administrador.',
    setupFieldLabels: {
      adminName: 'Nome completo',
      adminUser: 'Usuário',
      adminEmail: 'E-mail',
      adminPass: 'Senha',
      currency: 'Moeda',
      businessName: 'Nome do negócio',
      businessRnc: 'Documento fiscal',
      businessAddress: 'Endereço',
      businessPhone: 'Telefone',
      taxRate: 'Imposto (%)',
      printMode: 'Modo de impressão',
      paperSize: 'Tamanho do papel',
      printer: 'Impressora',
      openingAmount: 'Valor de abertura',
      openingNotes: 'Observações'
    },
    setupPlaceholders: {
      adminName: 'Ex: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@negocio.com',
      adminPass: 'Mínimo de 4 caracteres',
      businessName: 'Meu negócio',
      businessRnc: '000-00000-0',
      businessAddress: 'Rua, bairro, cidade',
      businessPhone: '809-000-0000',
      openingNotes: 'Ex: fundo inicial do caixa...'
    },
    setupOptionLabels: {
      printDialog: 'Mostrar diálogo do sistema',
      printDirect: 'Impressão direta',
      paper58: 'Ticket térmico 58mm',
      paper80: 'Ticket térmico 80mm',
      paperA4: 'Carta / A4',
      defaultPrinter: 'Usar impressora padrão'
    },
    cashGateTitle: 'Abrir caixa para começar',
    cashGateCopy: 'Antes de usar o sistema, você deve registrar a abertura do caixa desta sessão.'
  }),
  de: buildUiText({
    loginSubtitle: 'Professionelles Kassensystem',
    loginUser: 'Benutzer',
    loginPass: 'Passwort',
    loginButton: 'Anmelden',
    loginHint: 'Melde dich mit deinem registrierten Benutzer an.',
    loginHintSetupRequired: 'Wähle "Ich bin ein neuer Benutzer", um das erste Konto zu erstellen und die Ersteinrichtung abzuschließen.',
    loginLanguage: 'Sprache',
    loginExisting: 'Ich habe bereits ein Konto',
    loginNew: 'Ich bin ein neuer Benutzer',
    loginNewTitle: 'Wir richten dein Geschäft ein',
    loginNewText: 'Zuerst wählst du die Sprache, dann erstellst du den Administrator und legst Geschäftsart, Währung, Drucker und Startkasse fest.',
    loginNewAction: 'Ersteinrichtung starten',
    loginReinstallAction: 'Vorhandene App neu installieren',
    setupLogoText: 'Ersteinrichtung',
    setupSubtitle: 'Richte das Geschäft einmal ein und lasse das System arbeitsbereit.',
    setupSteps: ['1. Sprache', '2. Benutzer', '3. Geschäft', '4. Daten', '5. Druck', '6. Kasse'],
    setupPanels: [
      { title: 'Systemsprache', text: 'Wähle die Hauptsprache, die das Geschäft von Anfang an verwenden wird.' },
      { title: 'Erster Administrator', text: 'Dieser Benutzer erhält vollen Zugriff und eine 30-tägige Testphase.' },
      { title: 'Geschäftsart und Währung', text: 'Dadurch wird die App an das gewählte Geschäft angepasst.' },
      { title: 'Geschäftsdaten', text: 'Diese Daten erscheinen auf Belegen, in Einstellungen und Berichten.' },
      { title: 'Druck und Belege', text: 'Wähle Druckmodus und Papierformat, damit die Kasse einsatzbereit ist.' },
      { title: 'Erste Kassenöffnung', text: 'Öffne jetzt die Kasse, damit du direkt mit dem Kassieren starten kannst.' }
    ],
    setupBack: 'Zurück',
    setupNext: 'Weiter',
    setupFinish: 'Abschließen und starten',
    setupTrialNote: 'Die Vollversion bleibt 30 Tage aktiv. Danach kannst du die Lizenz über deine Admin-App freischalten.',
    setupFieldLabels: {
      adminName: 'Vollständiger Name',
      adminUser: 'Benutzername',
      adminEmail: 'E-Mail',
      adminPass: 'Passwort',
      currency: 'Währung',
      businessName: 'Geschäftsname',
      businessRnc: 'Steuernummer',
      businessAddress: 'Adresse',
      businessPhone: 'Telefon',
      taxRate: 'Steuer (%)',
      printMode: 'Druckmodus',
      paperSize: 'Papierformat',
      printer: 'Drucker',
      openingAmount: 'Startbetrag',
      openingNotes: 'Notizen'
    },
    setupPlaceholders: {
      adminName: 'Beispiel: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@geschaeft.de',
      adminPass: 'Mindestens 4 Zeichen',
      businessName: 'Mein Geschäft',
      businessRnc: '000-00000-0',
      businessAddress: 'Straße, Ort, Stadt',
      businessPhone: '809-000-0000',
      openingNotes: 'Beispiel: Startgeld für die Schicht...'
    },
    setupOptionLabels: {
      printDialog: 'Systemdialog anzeigen',
      printDirect: 'Direkt drucken',
      paper58: '58mm Thermobeleg',
      paper80: '80mm Thermobeleg',
      paperA4: 'Brief / A4',
      defaultPrinter: 'Standarddrucker verwenden'
    },
    cashGateTitle: 'Kasse öffnen',
    cashGateCopy: 'Bevor du das System benutzt, musst du die Kassenöffnung für diese Sitzung erfassen.'
  }),
  it: buildUiText({
    loginSubtitle: 'Sistema professionale punto vendita',
    loginUser: 'Utente',
    loginPass: 'Password',
    loginButton: 'Accedi',
    loginHint: 'Accedi con il tuo utente registrato per continuare.',
    loginHintSetupRequired: 'Scegli "Sono un nuovo utente" per creare il primo account e completare la configurazione iniziale.',
    loginLanguage: 'Lingua',
    loginExisting: 'Ho già un account',
    loginNew: 'Sono un nuovo utente',
    loginNewTitle: 'Configuriamo la tua attività',
    loginNewText: 'Prima scegli la lingua, poi crei l’utente amministratore e completi tipo di attività, valuta, stampante e cassa iniziale.',
    loginNewAction: 'Avvia prima configurazione',
    loginReinstallAction: 'Reinstalla un’app esistente',
    setupLogoText: 'Primo avvio',
    setupSubtitle: 'Configura l’attività una sola volta e lascia il sistema pronto per lavorare.',
    setupSteps: ['1. Lingua', '2. Utente', '3. Attività', '4. Dati', '5. Stampa', '6. Cassa'],
    setupPanels: [
      { title: 'Lingua del sistema', text: 'Scegli la lingua principale che l’attività userà fin dall’inizio.' },
      { title: 'Amministratore iniziale', text: 'Questo utente avrà accesso completo e una prova completa di 30 giorni.' },
      { title: 'Tipo di attività e valuta', text: 'Questo adatta l’app al tipo di attività scelto e alla sua struttura base.' },
      { title: 'Dati dell’attività', text: 'Questi dati appariranno su ricevute, configurazione e report.' },
      { title: 'Stampa e ricevute', text: 'Seleziona come stamperai e il formato carta per lasciare la cassa pronta.' },
      { title: 'Apertura iniziale cassa', text: 'Apri ora la cassa per entrare nel sistema già pronto a incassare.' }
    ],
    setupBack: 'Indietro',
    setupNext: 'Avanti',
    setupFinish: 'Completa e avvia',
    setupTrialNote: 'La prova completa resterà attiva per 30 giorni. Poi potrai validare la licenza dalla tua app amministratore.',
    setupFieldLabels: {
      adminName: 'Nome completo',
      adminUser: 'Utente',
      adminEmail: 'E-mail',
      adminPass: 'Password',
      currency: 'Valuta',
      businessName: 'Nome attività',
      businessRnc: 'Codice fiscale',
      businessAddress: 'Indirizzo',
      businessPhone: 'Telefono',
      taxRate: 'Imposta (%)',
      printMode: 'Modalità di stampa',
      paperSize: 'Formato carta',
      printer: 'Stampante',
      openingAmount: 'Importo iniziale',
      openingNotes: 'Note'
    },
    setupPlaceholders: {
      adminName: 'Es: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@attivita.it',
      adminPass: 'Minimo 4 caratteri',
      businessName: 'La mia attività',
      businessRnc: '000-00000-0',
      businessAddress: 'Via, zona, città',
      businessPhone: '809-000-0000',
      openingNotes: 'Es: fondo iniziale della cassa...'
    },
    setupOptionLabels: {
      printDialog: 'Mostra finestra di sistema',
      printDirect: 'Stampa diretta',
      paper58: 'Ticket termico 58mm',
      paper80: 'Ticket termico 80mm',
      paperA4: 'Lettera / A4',
      defaultPrinter: 'Usa stampante predefinita'
    },
    cashGateTitle: 'Apri la cassa per iniziare',
    cashGateCopy: 'Prima di usare il sistema devi registrare l’apertura della cassa per questa sessione.'
  }),
  nl: buildUiText({
    loginSubtitle: 'Professioneel kassasysteem',
    loginUser: 'Gebruiker',
    loginPass: 'Wachtwoord',
    loginButton: 'Inloggen',
    loginHint: 'Log in met je geregistreerde gebruiker om door te gaan.',
    loginHintSetupRequired: 'Kies "Ik ben een nieuwe gebruiker" om het eerste account aan te maken en de eerste configuratie te voltooien.',
    loginLanguage: 'Taal',
    loginExisting: 'Ik heb al een account',
    loginNew: 'Ik ben een nieuwe gebruiker',
    loginNewTitle: 'Laten we je bedrijf instellen',
    loginNewText: 'Kies eerst de taal, maak daarna de beheerder aan en voltooi bedrijfstype, valuta, printer en openingskas.',
    loginNewAction: 'Eerste configuratie starten',
    loginReinstallAction: 'Bestaande app opnieuw installeren',
    setupLogoText: 'Eerste start',
    setupSubtitle: 'Configureer het bedrijf eenmalig en laat het systeem klaar voor gebruik.',
    setupSteps: ['1. Taal', '2. Gebruiker', '3. Bedrijf', '4. Gegevens', '5. Afdrukken', '6. Kassa'],
    setupPanels: [
      { title: 'Systeemtaal', text: 'Kies de hoofdtaal die het bedrijf vanaf het begin gebruikt.' },
      { title: 'Eerste beheerder', text: 'Deze gebruiker krijgt volledige toegang en een proefperiode van 30 dagen.' },
      { title: 'Bedrijfstype en valuta', text: 'Dit past de app aan het gekozen type bedrijf aan.' },
      { title: 'Bedrijfsgegevens', text: 'Deze gegevens verschijnen op bonnen, instellingen en rapporten.' },
      { title: 'Afdrukken en bonnen', text: 'Kies hoe je gaat afdrukken en het papierformaat.' },
      { title: 'Eerste kassastart', text: 'Open nu de kassa zodat je direct kunt beginnen met verkopen.' }
    ],
    setupBack: 'Terug',
    setupNext: 'Volgende',
    setupFinish: 'Afronden en starten',
    setupTrialNote: 'De volledige proef blijft 30 dagen actief. Daarna kun je de licentie activeren vanuit je beheerapp.',
    setupFieldLabels: {
      adminName: 'Volledige naam',
      adminUser: 'Gebruiker',
      adminEmail: 'E-mail',
      adminPass: 'Wachtwoord',
      currency: 'Valuta',
      businessName: 'Bedrijfsnaam',
      businessRnc: 'Fiscaal nummer',
      businessAddress: 'Adres',
      businessPhone: 'Telefoon',
      taxRate: 'Belasting (%)',
      printMode: 'Afdrukmodus',
      paperSize: 'Papierformaat',
      printer: 'Printer',
      openingAmount: 'Openingsbedrag',
      openingNotes: 'Notities'
    },
    setupPlaceholders: {
      adminName: 'Bijv: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@bedrijf.nl',
      adminPass: 'Minimaal 4 tekens',
      businessName: 'Mijn bedrijf',
      businessRnc: '000-00000-0',
      businessAddress: 'Straat, wijk, stad',
      businessPhone: '809-000-0000',
      openingNotes: 'Bijv: openingsgeld voor vandaag...'
    },
    setupOptionLabels: {
      printDialog: 'Systeemvenster tonen',
      printDirect: 'Direct afdrukken',
      paper58: '58mm thermische bon',
      paper80: '80mm thermische bon',
      paperA4: 'Letter / A4',
      defaultPrinter: 'Standaardprinter gebruiken'
    },
    cashGateTitle: 'Kassa openen om te starten',
    cashGateCopy: 'Voordat je het systeem gebruikt, moet je de opening van de kassa registreren.'
  }),
  ru: buildUiText({
    loginSubtitle: 'Профессиональная POS-система',
    loginUser: 'Пользователь',
    loginPass: 'Пароль',
    loginButton: 'Войти',
    loginHint: 'Войдите под своей учетной записью, чтобы продолжить.',
    loginHintSetupRequired: 'Выберите "Я новый пользователь", чтобы создать первую учетную запись и завершить начальную настройку.',
    loginLanguage: 'Язык',
    loginExisting: 'У меня уже есть аккаунт',
    loginNew: 'Я новый пользователь',
    loginNewTitle: 'Давайте настроим ваш бизнес',
    loginNewText: 'Сначала выберите язык, затем создайте администратора и завершите выбор типа бизнеса, валюты, принтера и кассы.',
    loginNewAction: 'Начать первую настройку',
    loginReinstallAction: 'Переустановить существующее приложение',
    setupLogoText: 'Первый запуск',
    setupSubtitle: 'Настройте бизнес один раз и оставьте систему полностью готовой к работе.',
    setupSteps: ['1. Язык', '2. Пользователь', '3. Бизнес', '4. Данные', '5. Печать', '6. Касса'],
    setupPanels: [
      { title: 'Язык системы', text: 'Выберите основной язык, который бизнес будет использовать с самого начала.' },
      { title: 'Первый администратор', text: 'Этот пользователь получит полный доступ и 30 дней полной пробной версии.' },
      { title: 'Тип бизнеса и валюта', text: 'Это адаптирует приложение под выбранный бизнес.' },
      { title: 'Данные бизнеса', text: 'Эти данные будут отображаться в чеках, настройках и отчетах.' },
      { title: 'Печать и чеки', text: 'Выберите режим печати и размер бумаги, чтобы касса была готова.' },
      { title: 'Первичное открытие кассы', text: 'Откройте кассу сейчас, чтобы сразу начать работу.' }
    ],
    setupBack: 'Назад',
    setupNext: 'Далее',
    setupFinish: 'Завершить и начать',
    setupTrialNote: 'Полная пробная версия будет активна 30 дней. Затем вы сможете подтвердить лицензию через приложение администратора.',
    setupFieldLabels: {
      adminName: 'Полное имя',
      adminUser: 'Пользователь',
      adminEmail: 'E-mail',
      adminPass: 'Пароль',
      currency: 'Валюта',
      businessName: 'Название бизнеса',
      businessRnc: 'Налоговый номер',
      businessAddress: 'Адрес',
      businessPhone: 'Телефон',
      taxRate: 'Налог (%)',
      printMode: 'Режим печати',
      paperSize: 'Размер бумаги',
      printer: 'Принтер',
      openingAmount: 'Сумма открытия',
      openingNotes: 'Примечания'
    },
    setupPlaceholders: {
      adminName: 'Например: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@business.ru',
      adminPass: 'Минимум 4 символа',
      businessName: 'Мой бизнес',
      businessRnc: '000-00000-0',
      businessAddress: 'Улица, район, город',
      businessPhone: '809-000-0000',
      openingNotes: 'Например: стартовая сумма кассы...'
    },
    setupOptionLabels: {
      printDialog: 'Показать системное окно',
      printDirect: 'Прямая печать',
      paper58: 'Термочек 58мм',
      paper80: 'Термочек 80мм',
      paperA4: 'Letter / A4',
      defaultPrinter: 'Использовать принтер по умолчанию'
    },
    cashGateTitle: 'Открыть кассу для начала',
    cashGateCopy: 'Перед использованием системы необходимо зарегистрировать открытие кассы для этой смены.'
  }),
  zh: buildUiText({
    loginSubtitle: '专业收银销售系统',
    loginUser: '用户',
    loginPass: '密码',
    loginButton: '登录',
    loginHint: '使用已注册的账户登录以继续。',
    loginHintSetupRequired: '请选择“我是新用户”，先创建第一个账号并完成初始配置。',
    loginLanguage: '语言',
    loginExisting: '我已有账户',
    loginNew: '我是新用户',
    loginNewTitle: '开始配置你的店铺',
    loginNewText: '先选择语言，然后创建管理员，再完成业务类型、货币、打印机和开班设置。',
    loginNewAction: '开始首次配置',
    loginReinstallAction: '重新安装现有应用',
    setupLogoText: '首次启动',
    setupSubtitle: '只需配置一次，即可让系统准备好投入使用。',
    setupSteps: ['1. 语言', '2. 用户', '3. 业务', '4. 资料', '5. 打印', '6. 收银'],
    setupPanels: [
      { title: '系统语言', text: '选择店铺启动后要使用的主要语言。' },
      { title: '初始管理员', text: '该用户将拥有完整权限和 30 天完整试用。' },
      { title: '业务类型与货币', text: '这会让系统按所选业务自动适配。' },
      { title: '店铺资料', text: '这些资料会显示在小票、设置和报表中。' },
      { title: '打印与单据', text: '选择打印方式和纸张大小，让收银准备就绪。' },
      { title: '初始开箱', text: '现在打开收银箱，进入系统后即可直接收款。' }
    ],
    setupBack: '返回',
    setupNext: '下一步',
    setupFinish: '完成并开始',
    setupTrialNote: '完整试用将持续 30 天。之后你可以通过管理员应用验证许可证。',
    setupFieldLabels: {
      adminName: '姓名',
      adminUser: '用户名',
      adminEmail: '邮箱',
      adminPass: '密码',
      currency: '货币',
      businessName: '店铺名称',
      businessRnc: '税号',
      businessAddress: '地址',
      businessPhone: '电话',
      taxRate: '税率 (%)',
      printMode: '打印模式',
      paperSize: '纸张大小',
      printer: '打印机',
      openingAmount: '开箱金额',
      openingNotes: '备注'
    },
    setupPlaceholders: {
      adminName: '例如：Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@business.com',
      adminPass: '至少 4 个字符',
      businessName: '我的店铺',
      businessRnc: '000-00000-0',
      businessAddress: '街道、区域、城市',
      businessPhone: '809-000-0000',
      openingNotes: '例如：今日备用零钱...'
    },
    setupOptionLabels: {
      printDialog: '显示系统对话框',
      printDirect: '直接打印',
      paper58: '58mm 热敏小票',
      paper80: '80mm 热敏小票',
      paperA4: 'Letter / A4',
      defaultPrinter: '使用默认打印机'
    },
    cashGateTitle: '先开箱再开始',
    cashGateCopy: '在使用系统前，你必须先登记本次班次的开箱金额。'
  }),
  ar: buildUiText({
    loginSubtitle: 'نظام نقاط بيع احترافي',
    loginUser: 'المستخدم',
    loginPass: 'كلمة المرور',
    loginButton: 'تسجيل الدخول',
    loginHint: 'سجّل الدخول بحسابك المسجل للمتابعة.',
    loginHintSetupRequired: 'اختر "أنا مستخدم جديد" لإنشاء أول حساب وإكمال الإعداد الأولي.',
    loginLanguage: 'اللغة',
    loginExisting: 'لدي حساب بالفعل',
    loginNew: 'أنا مستخدم جديد',
    loginNewTitle: 'لنقم بإعداد نشاطك',
    loginNewText: 'اختر اللغة أولاً، ثم أنشئ المستخدم الإداري وأكمل نوع النشاط والعملة والطابعة وفتح الصندوق.',
    loginNewAction: 'بدء الإعداد الأول',
    loginReinstallAction: 'إعادة تثبيت تطبيق موجود',
    setupLogoText: 'البدء الأول',
    setupSubtitle: 'قم بإعداد النشاط مرة واحدة واترك النظام جاهزاً للعمل.',
    setupSteps: ['1. اللغة', '2. المستخدم', '3. النشاط', '4. البيانات', '5. الطباعة', '6. الصندوق'],
    setupPanels: [
      { title: 'لغة النظام', text: 'اختر اللغة الأساسية التي سيستخدمها النشاط من البداية.' },
      { title: 'المسؤول الأول', text: 'سيحصل هذا المستخدم على صلاحية كاملة وتجربة كاملة لمدة 30 يوماً.' },
      { title: 'نوع النشاط والعملة', text: 'هذا يكيّف التطبيق مع نوع النشاط المختار.' },
      { title: 'بيانات النشاط', text: 'ستظهر هذه البيانات في الفواتير والإعدادات والتقارير.' },
      { title: 'الطباعة والفواتير', text: 'اختر طريقة الطباعة وحجم الورق ليكون النظام جاهزاً.' },
      { title: 'فتح الصندوق الأول', text: 'افتح الصندوق الآن للدخول إلى النظام وجاهزاً للتحصيل.' }
    ],
    setupBack: 'رجوع',
    setupNext: 'التالي',
    setupFinish: 'إنهاء وبدء',
    setupTrialNote: 'ستبقى التجربة الكاملة مفعلة لمدة 30 يوماً. بعد ذلك يمكنك تفعيل الترخيص من تطبيق المدير.',
    setupFieldLabels: {
      adminName: 'الاسم الكامل',
      adminUser: 'اسم المستخدم',
      adminEmail: 'البريد الإلكتروني',
      adminPass: 'كلمة المرور',
      currency: 'العملة',
      businessName: 'اسم النشاط',
      businessRnc: 'الرقم الضريبي',
      businessAddress: 'العنوان',
      businessPhone: 'الهاتف',
      taxRate: 'الضريبة (%)',
      printMode: 'وضع الطباعة',
      paperSize: 'حجم الورق',
      printer: 'الطابعة',
      openingAmount: 'مبلغ الافتتاح',
      openingNotes: 'ملاحظات'
    },
    setupPlaceholders: {
      adminName: 'مثال: Emilio Perez',
      adminUser: 'admin',
      adminEmail: 'mail@business.com',
      adminPass: '4 أحرف على الأقل',
      businessName: 'نشاطي التجاري',
      businessRnc: '000-00000-0',
      businessAddress: 'الشارع، الحي، المدينة',
      businessPhone: '809-000-0000',
      openingNotes: 'مثال: مبلغ افتتاح الصندوق...'
    },
    setupOptionLabels: {
      printDialog: 'إظهار نافذة النظام',
      printDirect: 'طباعة مباشرة',
      paper58: 'إيصال حراري 58مم',
      paper80: 'إيصال حراري 80مم',
      paperA4: 'Letter / A4',
      defaultPrinter: 'استخدام الطابعة الافتراضية'
    },
    cashGateTitle: 'افتح الصندوق للبدء',
    cashGateCopy: 'قبل استخدام النظام يجب تسجيل مبلغ فتح الصندوق لهذه الجلسة.'
  })
};

const APP_UI_COPY = {
  es: {
    modules: {
      ventas: 'Ventas',
      productos: 'Productos',
      inventario: 'Inventario',
      clientes: 'Clientes',
      proveedores: 'Proveedores',
      caja: 'Caja',
      posmovil: 'POS Móvil',
      reportes: 'Reportes',
      movimientos: 'Movimientos',
      usuarios: 'Usuarios',
      configuracion: 'Configuración'
    },
    shell: {
      logout: 'Cerrar Sesión'
    },
    cash: {
      title: 'Gestión de Caja',
      open: 'Caja Abierta',
      closed: 'Caja Cerrada',
      openAction: 'Abrir Caja',
      closeAction: 'Cerrar Caja',
      openHint: 'Indica el monto inicial y deja una nota para la apertura.',
      closeHint: 'Registra el monto final y una observación antes de cerrar.',
      amountLabel: 'Monto Inicial / Final',
      notesLabel: 'Observaciones',
      notesPlaceholder: 'Notas...',
      expenseTitle: 'Registro de Egresos',
      expenseText: 'Controla todo lo que sale de caja sin mezclarlo con las ventas.',
      incomeTitle: 'Registro de Ingresos',
      incomeText: 'Usa este ingreso cuando te lleven dinero aparte que no viene de una venta normal.',
      incomeButton: 'Registrar ingreso',
      pendingDelivery: 'Contra entrega pendiente',
      pendingDeliveryEmpty: 'No hay cobros pendientes de delivery.',
      daySummary: 'Resumen del Día',
      cashSales: 'Ventas en Efectivo',
      cardSales: 'Ventas con Tarjeta',
      transferSales: 'Transferencias',
      totalSales: 'Total Ventas',
      expenses: 'Gastos',
      finalBalance: 'Balance Final',
      movements: 'Movimientos',
      noMovements: 'No hay movimientos registrados'
    },
    reports: {
      title: 'Reportes',
      exportPdf: 'Exportar PDF',
      today: 'Hoy',
      week: 'Esta Semana',
      month: 'Este Mes',
      year: 'Este Año',
      totalSales: 'Total Ventas',
      profits: 'Ganancias',
      topProduct: 'Producto Más Vendido',
      taxCollected: 'ITBIS Recaudado',
      afterCosts: 'Después de costos',
      trendTitle: 'Tendencia de ventas',
      trendText: 'Comportamiento del periodo seleccionado.',
      paymentMethods: 'Métodos de pago',
      paymentText: 'Participación por canal de cobro.',
      topProducts: 'Top productos',
      topProductsText: 'Lo más vendido en el periodo.',
      orderTypes: 'Tipos de pedido',
      orderTypesText: 'Mostrador, delivery, recoger o mesa.',
      operations: 'Rendimiento operativo',
      operationsText: 'Lectura rápida para tomar decisiones.',
      history: 'Historial de Ventas',
      historyText: 'Detalle de facturas emitidas en el periodo.',
      invoice: 'Factura',
      type: 'Tipo',
      date: 'Fecha',
      client: 'Cliente',
      cashier: 'Cajero',
      method: 'Método',
      total: 'Total',
      action: 'Acción'
    },
    settings: {
      title: 'Configuración General',
      save: 'Guardar Cambios',
      businessSection: 'Datos del Negocio',
      businessName: 'Nombre del Negocio',
      appLogo: 'Logo de la App',
      uploadLogo: 'Cargar logo',
      removeLogo: 'Quitar logo',
      rnc: 'RNC / Cédula',
      address: 'Dirección',
      phone: 'Teléfono',
      businessType: 'Tipo de negocio',
      businessStructure: 'Modo de operación',
      businessStructureSingle: 'Monocaja',
      businessStructureMulti: 'Multicaja',
      businessStructureBranches: 'Multisucursal',
      businessStructureHelperSingle: 'Monocaja usa una sola sucursal con una sola caja para mantener la operación simple.',
      businessStructureHelperMulti: 'Multicaja usa una sola sucursal con varias cajas sobre la misma base de datos.',
      businessStructureHelperBranches: 'Multisucursal habilita varias sucursales y sus cajas dentro del mismo sistema.',
      branchHelperSingle: 'Modo monocaja activo. Trabajarás con la sucursal principal y su única caja.',
      branchHelperMulti: 'Modo multicaja activo. Puedes crear varias cajas, pero todas pertenecerán a la misma sucursal.',
      branchHelperBranches: 'Modo multisucursal activo. Puedes crear sucursales y cajas según tu operación.',
      baseLanguage: 'Idioma base',
      billingSection: 'Facturación',
      currency: 'Moneda',
      tax: 'ITBIS (%)',
      invoicePrefix: 'Prefijo Factura',
      nextTicket: 'Próximo Ticket',
      eInvoiceToggle: 'Habilitar factura electrónica',
      eInvoicePrefix: 'Prefijo Factura Electrónica',
      nextEInvoice: 'Próxima Factura Electrónica',
      receiptMessage: 'Mensaje en Recibo',
      printMethod: 'Método de impresión',
      printDialog: 'Mostrar diálogo antes de imprimir',
      printDirect: 'Imprimir directo a la impresora',
      paperSize: 'Tamaño del papel',
      printer: 'Impresora de facturas',
      refreshPrinters: 'Actualizar',
      printerHelper: 'Puedes elegir la impresora térmica o dejar la predeterminada del sistema.',
      preview: 'Vista previa',
      previewButton: 'Vista previa de impresión',
      previewHelper: 'Revisa cómo se verá el ticket antes de cobrar o hacer una impresión real.',
      appearanceSection: 'Apariencia',
      theme: 'Tema',
      themeDark: 'Oscuro',
      themeLight: 'Claro',
      salesSplitView: 'Vista dividida en ventas',
      salesSplitViewHelper: 'Muestra el catálogo de productos a un lado y el pedido actual al otro para trabajar en pantalla dividida.',
      primaryColor: 'Color Primario',
      licenseStatus: 'Estado de licencia',
      licenseRefresh: 'Actualizar estado',
      licenseWhatsapp: 'Verificar por WhatsApp',
      businessGuideHeading: 'Guía del Negocio',
      businessGuideTitle: 'Guía rápida del negocio',
      businessGuideEmpty: 'Configura el negocio y personaliza esta guía desde tu operación.',
      backupSection: 'Respaldo',
      backupLabel: 'Copia de seguridad',
      backupText: 'Al cerrar la app se guarda automáticamente una copia segura cifrada en una carpeta protegida. También puedes exportar un respaldo manual en JSON.',
      backupDownload: 'Descargar copia',
      backupRestore: 'Restaurar copia segura',
      backupFolder: 'Abrir carpeta segura',
      accessSection: 'Acceso de la cuenta',
      accessUser: 'Usuario de acceso',
      accessMethods: 'Métodos disponibles',
      accessPassword: 'Contraseña de acceso',
      accessPasswordTextGoogle: 'Tu cuenta ya puede entrar con Google. Desde aquí puedes crear o cambiar una contraseña para entrar también con usuario y contraseña.',
      accessPasswordTextLocal: 'Desde aquí puedes crear o cambiar la contraseña local para entrar con tu usuario.',
      accessPasswordButtonCreate: 'Crear contraseña',
      accessPasswordButtonChange: 'Cambiar contraseña',
      accessMethodGoogleOnly: 'Google',
      accessMethodLocalOnly: 'Usuario y contraseña',
      accessMethodBoth: 'Google y usuario/contraseña',
      accessPasswordModalCreateTitle: 'Crear contraseña de acceso',
      accessPasswordModalChangeTitle: 'Cambiar contraseña de acceso',
      accessPasswordModalTextCreate: 'Crea una contraseña local para poder entrar también con tu usuario.',
      accessPasswordModalTextChange: 'Actualiza la contraseña local que usas para entrar con tu usuario.',
      accessPasswordCurrent: 'Contraseña actual',
      accessPasswordNew: 'Nueva contraseña',
      accessPasswordConfirm: 'Confirmar contraseña',
      accessPasswordCurrentPlaceholder: 'Escribe tu contraseña actual',
      accessPasswordNewPlaceholder: 'Mínimo 4 caracteres',
      accessPasswordConfirmPlaceholder: 'Repite la nueva contraseña',
      accessPasswordStatusCreate: 'Todavía no tienes una contraseña local creada.',
      accessPasswordStatusChange: 'Tu acceso local seguirá funcionando con la nueva contraseña.',
      securitySection: 'Seguridad',
      securityLabel: 'Clave de seguridad',
      securityText: 'Esta clave protege la restauración de copia segura, la apertura de la carpeta segura y la acción de eliminar todo.',
      securityChange: 'Cambiar clave',
      securityReset: 'Restablecer a fábrica',
      dangerSection: 'Zona de Peligro',
      dangerLabel: 'Eliminar todo',
      dangerText: 'Borra los datos locales del sistema y, si lo confirmas, también puede eliminar la información remota del negocio en Firebase. Antes de hacerlo, el sistema guarda una copia segura automática.',
      dangerButton: 'Eliminar todo'
    },
    license: {
      active: 'Licencia activa',
      suspended: 'Licencia suspendida',
      expired: 'Prueba vencida',
      trialShort: 'Prueba: {days} día(s)',
      trialLong: 'Prueba completa disponible por {days} día(s).',
      suspendedLong: 'La licencia fue suspendida desde tu app de administrador.',
      expiredLong: 'La prueba del sistema expiró.',
      whatsappOpenError: 'No se pudo abrir WhatsApp en este dispositivo.',
      whatsappMissingNumber: 'Configura el teléfono del negocio para usar WhatsApp.'
    }
  },
  default: {
    modules: {
      ventas: 'Sales',
      productos: 'Products',
      inventario: 'Inventory',
      clientes: 'Clients',
      proveedores: 'Suppliers',
      caja: 'Cash',
      posmovil: 'Mobile POS',
      reportes: 'Reports',
      movimientos: 'Movements',
      usuarios: 'Users',
      configuracion: 'Settings'
    },
    shell: {
      logout: 'Sign Out'
    },
    cash: {
      title: 'Cash Management',
      open: 'Cash Open',
      closed: 'Cash Closed',
      openAction: 'Open Cash',
      closeAction: 'Close Cash',
      openHint: 'Enter the opening amount and leave a note before opening.',
      closeHint: 'Register the final amount and a note before closing.',
      amountLabel: 'Opening / Closing Amount',
      notesLabel: 'Notes',
      notesPlaceholder: 'Notes...',
      expenseTitle: 'Expense Register',
      expenseText: 'Control everything leaving cash without mixing it with sales.',
      incomeTitle: 'Income Register',
      incomeText: 'Use this income when someone brings extra money unrelated to a normal sale.',
      incomeButton: 'Register income',
      pendingDelivery: 'Pending cash on delivery',
      pendingDeliveryEmpty: 'There are no pending delivery cash collections.',
      daySummary: 'Day Summary',
      cashSales: 'Cash Sales',
      cardSales: 'Card Sales',
      transferSales: 'Transfers',
      totalSales: 'Total Sales',
      expenses: 'Expenses',
      finalBalance: 'Final Balance',
      movements: 'Movements',
      noMovements: 'No movements registered'
    },
    reports: {
      title: 'Reports',
      exportPdf: 'Export PDF',
      today: 'Today',
      week: 'This Week',
      month: 'This Month',
      year: 'This Year',
      totalSales: 'Total Sales',
      profits: 'Profits',
      topProduct: 'Top Product',
      taxCollected: 'Tax Collected',
      afterCosts: 'After costs',
      trendTitle: 'Sales trend',
      trendText: 'Selected period performance.',
      paymentMethods: 'Payment methods',
      paymentText: 'Share by payment channel.',
      topProducts: 'Top products',
      topProductsText: 'Best selling items in the period.',
      orderTypes: 'Order types',
      orderTypesText: 'Counter, delivery, pickup or table.',
      operations: 'Operational performance',
      operationsText: 'Quick reading for decisions.',
      history: 'Sales History',
      historyText: 'Issued invoices for the selected period.',
      invoice: 'Invoice',
      type: 'Type',
      date: 'Date',
      client: 'Client',
      cashier: 'Cashier',
      method: 'Method',
      total: 'Total',
      action: 'Action'
    },
    settings: {
      title: 'General Settings',
      save: 'Save Changes',
      businessSection: 'Business Details',
      businessName: 'Business Name',
      appLogo: 'App Logo',
      uploadLogo: 'Upload logo',
      removeLogo: 'Remove logo',
      rnc: 'Tax ID',
      address: 'Address',
      phone: 'Phone',
      businessType: 'Business type',
      businessStructure: 'Operation mode',
      businessStructureSingle: 'Single register',
      businessStructureMulti: 'Multi-register',
      businessStructureBranches: 'Multi-branch',
      businessStructureHelperSingle: 'Single register uses one branch with one register to keep operations simple.',
      businessStructureHelperMulti: 'Multi-register uses one branch with several registers over the same database.',
      businessStructureHelperBranches: 'Multi-branch enables several branches and their registers inside the same system.',
      branchHelperSingle: 'Single register mode is active. You will work with the main branch and its only register.',
      branchHelperMulti: 'Multi-register mode is active. You can create several registers, but all of them belong to the same branch.',
      branchHelperBranches: 'Multi-branch mode is active. You can create branches and registers according to your operation.',
      baseLanguage: 'Base language',
      billingSection: 'Billing',
      currency: 'Currency',
      tax: 'Tax (%)',
      invoicePrefix: 'Invoice Prefix',
      nextTicket: 'Next Ticket',
      eInvoiceToggle: 'Enable e-invoice',
      eInvoicePrefix: 'E-Invoice Prefix',
      nextEInvoice: 'Next E-Invoice',
      receiptMessage: 'Receipt Message',
      printMethod: 'Print method',
      printDialog: 'Show dialog before printing',
      printDirect: 'Print directly to printer',
      paperSize: 'Paper size',
      printer: 'Invoice printer',
      refreshPrinters: 'Refresh',
      printerHelper: 'You can choose the thermal printer or leave the system default printer.',
      preview: 'Preview',
      previewButton: 'Print preview',
      previewHelper: 'Review how the receipt will look before charging or printing for real.',
      appearanceSection: 'Appearance',
      theme: 'Theme',
      themeDark: 'Dark',
      themeLight: 'Light',
      salesSplitView: 'Split sales view',
      salesSplitViewHelper: 'Shows the product catalog on one side and the current order on the other to work in split screen.',
      primaryColor: 'Primary Color',
      licenseStatus: 'License status',
      licenseRefresh: 'Refresh status',
      licenseWhatsapp: 'Verify by WhatsApp',
      businessGuideHeading: 'Business Guide',
      businessGuideTitle: 'Quick business guide',
      businessGuideEmpty: 'Set up the business and customize this guide from your operation.',
      backupSection: 'Backup',
      backupLabel: 'Backup copy',
      backupText: 'When the app closes, an encrypted secure backup is automatically stored in a protected folder. You can also export a manual JSON backup.',
      backupDownload: 'Download backup',
      backupRestore: 'Restore secure backup',
      backupFolder: 'Open secure folder',
      accessSection: 'Account access',
      accessUser: 'Login user',
      accessMethods: 'Available methods',
      accessPassword: 'Access password',
      accessPasswordTextGoogle: 'Your account can already sign in with Google. From here you can also create or change a local password to sign in with user name and password.',
      accessPasswordTextLocal: 'From here you can create or change the local password used to sign in with your user name.',
      accessPasswordButtonCreate: 'Create password',
      accessPasswordButtonChange: 'Change password',
      accessMethodGoogleOnly: 'Google',
      accessMethodLocalOnly: 'User name and password',
      accessMethodBoth: 'Google and user/password',
      accessPasswordModalCreateTitle: 'Create access password',
      accessPasswordModalChangeTitle: 'Change access password',
      accessPasswordModalTextCreate: 'Create a local password so you can also sign in with your user name.',
      accessPasswordModalTextChange: 'Update the local password you use to sign in with your user name.',
      accessPasswordCurrent: 'Current password',
      accessPasswordNew: 'New password',
      accessPasswordConfirm: 'Confirm password',
      accessPasswordCurrentPlaceholder: 'Enter your current password',
      accessPasswordNewPlaceholder: 'Minimum 4 characters',
      accessPasswordConfirmPlaceholder: 'Repeat the new password',
      accessPasswordStatusCreate: 'You do not have a local password yet.',
      accessPasswordStatusChange: 'Your local access will keep working with the new password.',
      securitySection: 'Security',
      securityLabel: 'Security password',
      securityText: 'This password protects secure backup restore, opening the secure folder and the delete-all action.',
      securityChange: 'Change password',
      securityReset: 'Reset to factory',
      dangerSection: 'Danger Zone',
      dangerLabel: 'Delete everything',
      dangerText: 'Deletes local system data and, if you confirm it, can also remove the business remote data from Firebase. Before doing it, the system stores an automatic secure backup.',
      dangerButton: 'Delete everything'
    },
    license: {
      active: 'License active',
      suspended: 'License suspended',
      expired: 'Trial expired',
      trialShort: 'Trial: {days} day(s)',
      trialLong: 'Full trial available for {days} day(s).',
      suspendedLong: 'The license was suspended from your admin app.',
      expiredLong: 'The system trial has expired.',
      whatsappOpenError: 'Could not open WhatsApp on this device.',
      whatsappMissingNumber: 'Set the business phone number to use WhatsApp.'
    }
  }
};

function appText(path, fallback = '') {
  const lang = getCurrentLanguage();
  const segments = String(path || '').split('.');

  let value = APP_UI_COPY[lang];
  for (const segment of segments) value = value?.[segment];
  if (value !== undefined) return value;

  let baseValue = APP_UI_COPY.es;
  for (const segment of segments) baseValue = baseValue?.[segment];
  if (baseValue !== undefined) {
    return lang === 'es' || typeof window.translateUiString !== 'function'
      ? baseValue
      : window.translateUiString(baseValue, lang);
  }

  let defaultValue = APP_UI_COPY.default;
  for (const segment of segments) defaultValue = defaultValue?.[segment];
  if (defaultValue !== undefined) {
    return lang === 'en' || typeof window.translateUiString !== 'function'
      ? defaultValue
      : window.translateUiString(defaultValue, lang);
  }

  if (!fallback) return fallback;
  return typeof window.translateUiString === 'function'
    ? window.translateUiString(fallback, lang)
    : fallback;
}

function fillText(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_match, key) => values[key] ?? '');
}

function normalizeBusinessStructureMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'monocaja';
  if (['monocaja', 'mono-caja', 'mono_caja', 'single-register', 'single_register', 'singleregister',
       'mononegocio', 'mononegocios', 'mono-negocio', 'mono-negocios', 'singlebusiness',
       'single-business', 'single_business'].includes(normalized)) {
    return 'monocaja';
  }
  // Sucursal: terminal secundaria (requiere auth)
  if (['sucursal', 'sucursal-secundaria', 'branch', 'branch-terminal'].includes(normalized)) {
    return 'sucursal';
  }
  if (['multicaja', 'multi-caja', 'multi_caja', 'multiregister', 'multi-register', 'multi_register'].includes(normalized)) {
    return 'multicaja';
  }
  if (['multisucursal', 'multi-sucursal', 'multi_sucursal', 'multibranch', 'multi-branch', 'multi_branch'].includes(normalized)) {
    return 'multisucursal';
  }
  return 'monocaja';
}

function getBusinessStructureOptionsForUi() {
  return [
    { value: 'monocaja',      label: 'Monocaja',      subtitle: 'Una sola caja, negocio independiente' },
    { value: 'multicaja',     label: 'Multicaja',      subtitle: 'Varias cajas en la misma red local' },
    { value: 'sucursal',      label: 'Sucursal',       subtitle: 'Terminal secundaria vinculada al sistema principal' },
    { value: 'multisucursal', label: 'Multisucursal',  subtitle: 'Varios locales con panel central' }
  ];
}

function translateCatalogText(value) {
  if (value === undefined || value === null) return '';
  return typeof window.translateUiString === 'function'
    ? window.translateUiString(String(value), getCurrentLanguage())
    : String(value);
}

function getLocalizedProductName(productOrName) {
  const value = typeof productOrName === 'string' ? productOrName : productOrName?.nombre;
  return translateCatalogText(value || '');
}

function getLocalizedCategoryName(category) {
  return translateCatalogText(category || '');
}

function getAvailableLanguages() {
  return Array.isArray(setupState?.languages) && setupState.languages.length
    ? setupState.languages
    : [
        { value: 'es', label: 'Español' },
        { value: 'en', label: 'English' }
      ];
}

function getActorPayload() {
  return DB.currentUser ? {
    actorUserId: DB.currentUser.id,
    actorUserName: DB.currentUser.nombre,
    actorUserRole: DB.currentUser.rol
  } : {};
}

function normalizeCurrentUserRoleCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'administrador' || normalized === 'administrador_general' || normalized === 'admin') return 'administrador_general';
  if (normalized === 'administrador sucursal' || normalized === 'administrador_sucursal') return 'administrador_sucursal';
  if (normalized === 'supervisor') return 'supervisor';
  if (normalized === 'cajero' || normalized === 'delivery') return 'cajero';
  return normalized;
}

function getCurrentUserRoleCode() {
  return normalizeCurrentUserRoleCode(DB.currentUser?.roleCode || DB.currentUser?.rol);
}

function getVisibleModulesForCurrentRole() {
  const roleCode = getCurrentUserRoleCode();
  if (roleCode === 'administrador_sucursal') {
    return new Set(['ventas', 'inventario', 'caja', 'colacobro', 'reportes', 'usuarios', 'delivery']);
  }
  if (roleCode === 'cajero') {
    return new Set(['ventas', 'clientes', 'caja', 'colacobro', 'reportes', 'delivery']);
  }
  return null;
}

function getBusinessStructurePayload() {
  return {
    branchId: Number(DB.config?.activeBranchId || 0) || null,
    cashRegisterId: Number(DB.config?.activeCashRegisterId || 0) || null
  };
}

function getActiveBranch() {
  const activeBranchId = Number(DB.config?.activeBranchId || 0);
  return activeBranchId ? DB.sucursales.find((item) => Number(item.id) === activeBranchId) || null : null;
}

function getCashRegistersForBranch(branchId = null) {
  const normalizedBranchId = Number(branchId || DB.config?.activeBranchId || 0);
  return (DB.cajasSucursal || []).filter((item) => Number(item.sucursalId || 0) === normalizedBranchId);
}

function getActiveCashRegister() {
  const activeCashRegisterId = Number(DB.config?.activeCashRegisterId || 0);
  return activeCashRegisterId ? DB.cajasSucursal.find((item) => Number(item.id) === activeCashRegisterId) || null : null;
}

function normalizeBillingFunctionUi(value, fallback = 'mixta') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['mixta', 'facturacion', 'cobro', 'centralizadora'].includes(normalized) ? normalized : fallback;
}

function getBillingFunctionLabelUi(value) {
  const normalized = normalizeBillingFunctionUi(value);
  return {
    mixta: 'Mixta',
    facturacion: 'Facturación',
    cobro: 'Cobro',
    centralizadora: 'Centralizadora'
  }[normalized] || 'Mixta';
}

function getBillingFunctionCapabilitiesUi(value) {
  const type = normalizeBillingFunctionUi(value);
  if (type === 'facturacion') {
    return { type, canCreateSales: true, canChargePending: false, forcePendingCharge: true };
  }
  if (type === 'cobro') {
    return { type, canCreateSales: false, canChargePending: true, forcePendingCharge: false };
  }
  return { type, canCreateSales: true, canChargePending: true, forcePendingCharge: false };
}

function getEffectiveBillingCapabilities(options = {}) {
  const userType = normalizeBillingFunctionUi(options.userType ?? DB.currentUser?.tipoFacturacion ?? 'mixta');
  const cashRegisterType = normalizeBillingFunctionUi(options.cashRegisterType ?? getActiveCashRegister()?.tipoCaja ?? 'mixta');
  const userCaps = getBillingFunctionCapabilitiesUi(userType);
  const cashCaps = getBillingFunctionCapabilitiesUi(cashRegisterType);

  return {
    userType,
    userTypeLabel: getBillingFunctionLabelUi(userType),
    cashRegisterType,
    cashRegisterTypeLabel: getBillingFunctionLabelUi(cashRegisterType),
    canCreateSales: Boolean(userCaps.canCreateSales && cashCaps.canCreateSales),
    canChargePending: Boolean(userCaps.canChargePending && cashCaps.canChargePending),
    forcePendingCharge: Boolean(
      userCaps.canCreateSales
      && cashCaps.canCreateSales
      && (userCaps.forcePendingCharge || cashCaps.forcePendingCharge)
    )
  };
}

window.TecnoCajaBilling = {
  normalizeBillingFunctionUi,
  getBillingFunctionLabelUi,
  getBillingFunctionCapabilitiesUi,
  getEffectiveBillingCapabilities
};

function isAdministrator() {
  return getCurrentUserRoleCode() === 'administrador_general';
}

function getBusinessRuntimeConfig() {
  if (typeof window.getBusinessConfig === 'function') {
    return window.getBusinessConfig(DB.config?.tipoNegocio || DB.config?.businessProfile?.key || 'pizzeria');
  }
  return {
    modules: ['ventas', 'productos', 'inventario', 'clientes', 'proveedores', 'caja', 'colacobro', 'posmovil', 'reportes', 'movimientos', 'usuarios', 'configuracion', 'delivery'],
    productFields: [],
    features: [],
    salesFlow: {},
    dashboard: {}
  };
}

function isBusinessModuleEnabled(name) {
  const config = getBusinessRuntimeConfig();
  const modules = Array.isArray(config.modules) ? config.modules : [];
  return !modules.length || modules.includes(name);
}

function getBusinessFeatureList() {
  const config = getBusinessRuntimeConfig();
  return Array.isArray(config.features) ? config.features : [];
}

function cloneTrialBusinessValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    if (Array.isArray(value)) return [...value];
    if (value && typeof value === 'object') return { ...value };
    return value;
  }
}

function isTrialBusinessModeActive() {
  return Boolean(trialBusinessState.active && trialBusinessState.preview);
}

function getTrialModeBlockedMessage() {
  return 'El modo prueba está activo. Puedes navegar y usar el catálogo demo, pero no guardar ventas ni cambios permanentes hasta salir del modo prueba.';
}

function shouldBlockTrialModeRequest(url, method = 'GET') {
  if (!isTrialBusinessModeActive()) return false;
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return false;

  const path = String(url || '').split('?')[0];
  const allowedPrefixes = [
    '/api/config/whatsapp-guide',
    '/api/config',
    '/api/qrcode',
    '/api/license/activate',
    '/api/account/access-password',
    '/api/security-password/verify'
  ];
  if (allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return false;
  }

  const blockedPrefixes = [
    '/api/sales',
    '/api/products',
    '/api/categories',
    '/api/inventory/adjust',
    '/api/clients',
    '/api/suppliers',
    '/api/supplier-invoices',
    '/api/users',
    '/api/cash',
    '/api/suspended-sales',
    '/api/quotations',
    '/api/backup/restore',
    '/api/system/reset'
  ];

  return blockedPrefixes.some((prefix) => path.startsWith(prefix));
}

window.isTrialBusinessModeActive = isTrialBusinessModeActive;
window.getTrialModeBlockedMessage = getTrialModeBlockedMessage;
window.shouldBlockTrialModeRequest = shouldBlockTrialModeRequest;

function getAvailableTrialBusinessTypes() {
  if (trialBusinessCatalog.length) return trialBusinessCatalog;
  if (Array.isArray(setupState?.businessTypes) && setupState.businessTypes.length) return setupState.businessTypes;
  return [];
}

function ensureTrialBusinessSnapshot() {
  if (trialBusinessState.snapshot) return;
  trialBusinessState.snapshot = {
    tipoNegocio: DB.config?.tipoNegocio || 'pizzeria',
    businessProfile: cloneTrialBusinessValue(DB.config?.businessProfile || null),
    categorias: cloneTrialBusinessValue(DB.categorias || []),
    productos: cloneTrialBusinessValue(DB.productos || [])
  };
}

function applyTrialBusinessPreviewState(preview) {
  if (!preview) return;
  trialBusinessState.preview = cloneTrialBusinessValue(preview);
  trialBusinessState.active = true;
  DB.config = {
    ...DB.config,
    tipoNegocio: preview.businessType || preview.profile?.key || DB.config?.tipoNegocio || 'pizzeria',
    businessProfile: cloneTrialBusinessValue(preview.profile || null)
  };
  DB.categorias = cloneTrialBusinessValue(preview.categories || []);
  DB.productos = cloneTrialBusinessValue(preview.products || []);
}

function restoreTrialBusinessSnapshot() {
  if (!trialBusinessState.snapshot) return;
  DB.config = {
    ...DB.config,
    tipoNegocio: trialBusinessState.snapshot.tipoNegocio || DB.config?.tipoNegocio || 'pizzeria',
    businessProfile: cloneTrialBusinessValue(trialBusinessState.snapshot.businessProfile || null)
  };
  DB.categorias = cloneTrialBusinessValue(trialBusinessState.snapshot.categorias || []);
  DB.productos = cloneTrialBusinessValue(trialBusinessState.snapshot.productos || []);
}

function clearTrialBusinessRuntimeState() {
  trialBusinessState = {
    active: false,
    preview: null,
    snapshot: null
  };
}

function restoreActiveTrialBusinessPreview() {
  if (!isTrialBusinessModeActive()) return;
  applyTrialBusinessPreviewState(trialBusinessState.preview);
}

function syncTrialBusinessPill() {
  const pill = document.getElementById('trial-business-pill');
  if (!pill) return;
  if (!isTrialBusinessModeActive()) {
    pill.classList.add('hidden');
    pill.textContent = '';
    return;
  }
  const label = trialBusinessState.preview?.label
    || trialBusinessState.preview?.profile?.label
    || DB.config?.businessProfile?.label
    || DB.config?.tipoNegocio
    || 'Demo';
  pill.textContent = `🧪 Prueba: ${label}`;
  pill.classList.remove('hidden');
}

function buildTrialBusinessStatusText() {
  if (!isTrialBusinessModeActive()) {
    return 'Modo prueba desactivado. Selecciona un negocio demo para revisar su interfaz, módulos y catálogo sin crear otra cuenta.';
  }
  const preview = trialBusinessState.preview || {};
  const label = preview.label || preview.profile?.label || 'Negocio demo';
  const productCount = Array.isArray(preview.products) ? preview.products.length : 0;
  const categoryCount = Array.isArray(preview.categories) ? preview.categories.length : 0;
  return `Modo prueba activo en ${label}. Catálogo demo cargado: ${productCount} producto(s) y ${categoryCount} categoría(s). Mientras esté activo, las acciones permanentes quedan bloqueadas para proteger tus datos reales.`;
}

function syncTrialBusinessConfigPanel() {
  const select = document.getElementById('cfg-trial-business-type');
  const status = document.getElementById('cfg-trial-business-status');
  const activateButton = document.getElementById('cfg-btn-trial-activate');
  const deactivateButton = document.getElementById('cfg-btn-trial-deactivate');
  const items = getAvailableTrialBusinessTypes();

  if (select) {
    const currentSelection = isTrialBusinessModeActive()
      ? (trialBusinessState.preview?.businessType || trialBusinessState.preview?.profile?.key || DB.config?.tipoNegocio || 'pizzeria')
      : (select.value || DB.config?.tipoNegocio || 'pizzeria');
    select.innerHTML = items.length
      ? items.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')
      : '<option value="">Cargando negocios demo...</option>';
    select.disabled = !items.length;
    const preferredValue = items.some((item) => item.value === currentSelection)
      ? currentSelection
      : (items[0]?.value || '');
    select.value = preferredValue;
  }

  if (activateButton) {
    activateButton.disabled = !items.length;
  }
  if (deactivateButton) {
    deactivateButton.disabled = !isTrialBusinessModeActive();
  }
  if (status) {
    status.textContent = buildTrialBusinessStatusText();
    status.classList.toggle('is-inactive', !isTrialBusinessModeActive());
  }
}

async function ensureTrialBusinessCatalog(forceReload = false) {
  if (!forceReload && trialBusinessCatalog.length) {
    syncTrialBusinessConfigPanel();
    return trialBusinessCatalog;
  }
  try {
    const response = await api.getBusinessTemplates();
    trialBusinessCatalog = Array.isArray(response?.items) ? response.items : [];
  } catch (_error) {
    trialBusinessCatalog = getAvailableTrialBusinessTypes();
  }
  syncTrialBusinessConfigPanel();
  return trialBusinessCatalog;
}

function confirmTrialBusinessSwitch(actionLabel) {
  if (!Array.isArray(DB.saleItems) || !DB.saleItems.length) return true;
  return window.confirm(`Hay un pedido actual abierto. Para ${actionLabel} se limpiará ese pedido. ¿Quieres continuar?`);
}

function resetTrialBusinessWorkspace() {
  if (typeof cancelSale === 'function') {
    cancelSale();
  } else {
    DB.saleItems = [];
  }
  const dropdown = document.getElementById('search-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

function refreshBusinessModeUi() {
  applyBusinessProfile();
  syncConfigForm();
  applyRolePermissions();
  if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
  if (typeof refreshInventoryCategoryFilter === 'function') refreshInventoryCategoryFilter();
  if (typeof loadProductsTable === 'function') loadProductsTable();
  if (typeof loadInventoryTable === 'function') loadInventoryTable();
  if (typeof renderSaleTable === 'function') renderSaleTable();
  if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
  if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
  if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
  if (typeof updateTotals === 'function') updateTotals();
  if (typeof updateInventoryStats === 'function') updateInventoryStats();
  syncTrialBusinessPill();
  syncTrialBusinessConfigPanel();
  translateDynamicUi(document.body);
}

async function activateTrialBusinessMode() {
  const select = document.getElementById('cfg-trial-business-type');
  const businessType = String(select?.value || '').trim().toLowerCase();
  if (!businessType) {
    showToast('Selecciona primero el negocio demo que quieres probar.', 'warning');
    return;
  }

  const items = await ensureTrialBusinessCatalog();
  const selectedItem = items.find((item) => item.value === businessType);
  if (!selectedItem) {
    showToast('No se encontró el negocio demo seleccionado.', 'error');
    return;
  }
  if (!confirmTrialBusinessSwitch(`activar el modo prueba de ${selectedItem.label}`)) {
    return;
  }

  try {
    const preview = await api.getBusinessTemplatePreview(businessType);
    ensureTrialBusinessSnapshot();
    resetTrialBusinessWorkspace();
    applyTrialBusinessPreviewState(preview);
    refreshBusinessModeUi();
    showToast(`Modo prueba activo: ${selectedItem.label}`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo activar el modo prueba.', 'error');
  }
}

function deactivateTrialBusinessMode(showFeedback = true) {
  if (!isTrialBusinessModeActive()) {
    syncTrialBusinessConfigPanel();
    if (showFeedback) {
      showToast('El modo prueba ya está desactivado.', 'warning');
    }
    return;
  }
  const label = trialBusinessState.preview?.label || trialBusinessState.preview?.profile?.label || 'seleccionado';
  if (!confirmTrialBusinessSwitch(`salir del modo prueba de ${label}`)) {
    return;
  }

  resetTrialBusinessWorkspace();
  restoreTrialBusinessSnapshot();
  clearTrialBusinessRuntimeState();
  refreshBusinessModeUi();
  if (showFeedback) {
    showToast('Volviste a tu negocio real.', 'success');
  }
}

window.activateTrialBusinessMode = activateTrialBusinessMode;
window.deactivateTrialBusinessMode = deactivateTrialBusinessMode;

function canAccessModule(name) {
  if (!isBusinessModuleEnabled(name)) {
    return false;
  }
  if (window.TecnoCajaPlans && !window.TecnoCajaPlans.isModuleAllowed(name)) {
    return false;
  }
  if (!DB.currentUser) return true;
  const visibleModules = getVisibleModulesForCurrentRole();
  if (visibleModules && !visibleModules.has(name)) {
    return false;
  }
  const billingCaps = getEffectiveBillingCapabilities();
  if (name === 'ventas' && !billingCaps.canCreateSales) {
    return false;
  }
  if (name === 'colacobro' && !billingCaps.canChargePending) {
    return false;
  }
  return true;
}

function _updatePlanBadge() {
  const badge = document.getElementById('plan-sidebar-badge');
  const label = document.getElementById('plan-sidebar-label');
  if (!badge || !label) return;

  const PLAN_NAMES_LOCAL = { basico: 'Tecno Caja Básico', pro: 'Tecno Caja Pro', plus: 'Tecno Caja Plus' };
  const MODE_MAP = { multisucursal: 'plus', sucursal: 'plus', multicaja: 'pro', monocaja: 'basico' };

  const mode       = String(DB?.config?.businessStructureMode || '').toLowerCase();
  const stored     = String(DB?.config?.planCode || '').toLowerCase();
  const fromMode   = MODE_MAP[mode] || 'basico';
  const LEVELS     = { basico: 1, pro: 2, plus: 3 };
  // Usar el mayor entre el plan guardado y el derivado del modo
  const planCode   = (LEVELS[stored] || 0) >= (LEVELS[fromMode] || 1) ? (stored || 'basico') : fromMode;
  const planName   = PLAN_NAMES_LOCAL[planCode] || window.TecnoCajaPlans?.PLAN_NAMES?.[planCode] || planCode;

  label.textContent = planName;
  badge.title = `Plan activo: ${planName}`;
}
window._updatePlanBadge = _updatePlanBadge;

function applyRolePermissions() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    const deniedRole = item.dataset.denyRole;
    const moduleName = item.dataset.module || '';
    const hiddenByLegacyRole = Boolean(deniedRole && deniedRole === (DB.currentUser?.rol || ''));
    const hiddenByBusiness = !isBusinessModuleEnabled(moduleName);
    const hiddenByScopedAccess = !canAccessModule(moduleName);
    item.classList.toggle('hidden', hiddenByLegacyRole || hiddenByBusiness || hiddenByScopedAccess);
  });
  _updatePlanBadge();

  const activeModule = document.querySelector('.nav-item.active');
  const activeModuleName = activeModule?.dataset.module || '';
  if (activeModuleName && !canAccessModule(activeModuleName)) {
    const fallbackNav = document.querySelector('.nav-item[data-module="ventas"]:not(.hidden)') || document.querySelector('.nav-item:not(.hidden)');
    if (fallbackNav) {
      showModule(fallbackNav.dataset.module, fallbackNav);
    }
  }
}

async function refreshAuditLogs() {
  try {
    DB.movimientosSistema = await api.getAuditLogs();
    if (typeof syncMovimientosModuleFilter === 'function') syncMovimientosModuleFilter();
    if (typeof renderMovimientosSistema === 'function') renderMovimientosSistema();
    updateNotifications();
  } catch (_error) {
    // Keep the app usable even if the audit module is temporarily unavailable.
  }
}

async function refreshOperationalData() {
  try {
    DB.deliveryLocations = await api.getDeliveryLocations();
  } catch (_error) {
    DB.deliveryLocations = DB.deliveryLocations || [];
  }
  try {
    DB.mesas = await api.getDiningTables();
  } catch (_error) {
    DB.mesas = DB.mesas || [];
  }
}

function canExitApp() {
  if (DB.currentUser && cajaAbierta) {
    return {
      allowed: false,
      reason: 'Debes cerrar tu caja antes de salir del sistema.'
    };
  }
  return { allowed: true };
}

window.canExitApp = canExitApp;

function getCurrentLanguage() {
  if (!DB.currentUser && !(setupState?.setupCompleted || DB.config?.setupCompleted)) {
    return setupWizard.language || 'es';
  }
  return DB.config?.idioma || setupWizard.language || 'es';
}

function getCurrentLocale() {
  const language = getCurrentLanguage();
  if (language === 'en') return 'en-US';
  if (language === 'fr') return 'fr-FR';
  if (language === 'pt') return 'pt-BR';
  if (language === 'de') return 'de-DE';
  if (language === 'it') return 'it-IT';
  if (language === 'nl') return 'nl-NL';
  if (language === 'ru') return 'ru-RU';
  if (language === 'zh') return 'zh-CN';
  if (language === 'ar') return 'ar-SA';
  return 'es-DO';
}

function getUiText() {
  return UI_TEXT[getCurrentLanguage()] || UI_TEXT.es;
}

function updateStaticUiTexts() {
  const copy = getUiText();
  const loginSubtitle = document.getElementById('login-subtitle');
  const loginUser = document.getElementById('login-user-label');
  const loginPass = document.getElementById('login-pass-label');
  const loginLanguage = document.getElementById('login-language-label');
  const loginButton = document.getElementById('login-submit-button');
  const loginGoogleButton = document.getElementById('login-google-button-text');
  const loginGoogleSetupButton = document.getElementById('login-google-setup-button-text');
  const loginHint = document.getElementById('login-hint');
  const loginExisting = document.getElementById('login-mode-existing');
  const loginNew = document.getElementById('login-mode-new');
  const loginNewTitle = document.getElementById('login-new-title');
  const loginNewText = document.getElementById('login-new-text');
  const loginNewAction = document.getElementById('login-new-action');
  const loginReinstallAction = document.getElementById('login-reinstall-action');
  const setupLogoText = document.getElementById('setup-logo-text');
  const setupSubtitle = document.getElementById('setup-subtitle');
  const setupTrialNote = document.getElementById('setup-trial-note');
  const setupStructureLabel = document.getElementById('setup-structure-label');
  const setupStructureHelp = document.getElementById('setup-structure-help');
  const cashGateTitle = document.querySelector('#cash-gate-screen h2');
  const cashGateCopy = document.getElementById('cash-gate-copy');
  document.documentElement.lang = getCurrentLanguage();
  document.documentElement.dir = getCurrentLanguage() === 'ar' ? 'rtl' : 'ltr';
  if (loginSubtitle) {
    loginSubtitle.textContent = getCurrentLanguage() === 'es'
      ? (DB.config?.businessProfile?.loginSubtitle || copy.loginSubtitle)
      : copy.loginSubtitle;
  }
  if (loginUser) loginUser.textContent = copy.loginUser;
  if (loginPass) loginPass.textContent = copy.loginPass;
  if (loginLanguage) loginLanguage.textContent = copy.loginLanguage;
  if (loginButton) loginButton.textContent = copy.loginButton;
  if (loginGoogleButton) loginGoogleButton.textContent = copy.loginGoogleButton;
  if (loginGoogleSetupButton) loginGoogleSetupButton.textContent = copy.loginGoogleSetupButton || copy.loginGoogleButton;
  if (loginHint) loginHint.textContent = copy.loginHint;
  if (loginExisting) loginExisting.textContent = copy.loginExisting;
  if (loginNew) loginNew.textContent = copy.loginNew;
  if (loginNewTitle) loginNewTitle.textContent = copy.loginNewTitle;
  if (loginNewText) loginNewText.textContent = copy.loginNewText;
  if (loginNewAction) loginNewAction.textContent = copy.loginNewAction;
  if (loginReinstallAction) loginReinstallAction.textContent = copy.loginReinstallAction;
  if (setupLogoText) setupLogoText.textContent = copy.setupLogoText;
  if (setupSubtitle) setupSubtitle.textContent = copy.setupSubtitle;
  if (setupTrialNote) setupTrialNote.textContent = copy.setupTrialNote;
  if (setupStructureLabel) setupStructureLabel.textContent = copy.setupStructureLabel || BASE_UI_TEXT.setupStructureLabel;
  if (setupStructureHelp) setupStructureHelp.textContent = copy.setupStructureHelp || BASE_UI_TEXT.setupStructureHelp;
  document.querySelectorAll('#setup-steps .setup-step-dot').forEach((dot, index) => {
    dot.textContent = copy.setupSteps?.[index] || dot.textContent;
  });
  document.querySelectorAll('.setup-step-panel').forEach((panel, index) => {
    const title = panel.querySelector('h3');
    const text = panel.querySelector('p');
    if (title) title.textContent = copy.setupPanels?.[index]?.title || title.textContent;
    if (text) text.textContent = copy.setupPanels?.[index]?.text || text.textContent;
  });
  const setupBack = document.getElementById('setup-back-btn');
  const setupNext = document.getElementById('setup-next-btn');
  const setupFinish = document.getElementById('setup-finish-btn');
  if (setupBack) setupBack.textContent = copy.setupBack;
  if (setupNext) setupNext.textContent = copy.setupNext;
  if (setupFinish) setupFinish.textContent = copy.setupFinish;
  const setupFieldLabels = copy.setupFieldLabels || {};
  const setupPlaceholders = copy.setupPlaceholders || {};
  const setupOptionLabels = copy.setupOptionLabels || {};
  const labelMap = {
    'setup-admin-name-label': setupFieldLabels.adminName,
    'setup-admin-user-label': setupFieldLabels.adminUser,
    'setup-admin-email-label': setupFieldLabels.adminEmail,
    'setup-admin-pass-label': setupFieldLabels.adminPass,
    'setup-structure-label': setupFieldLabels.structure,
    'setup-currency-label': setupFieldLabels.currency,
    'setup-business-name-label': setupFieldLabels.businessName,
    'setup-business-rnc-label': setupFieldLabels.businessRnc,
    'setup-business-address-label': setupFieldLabels.businessAddress,
    'setup-business-phone-label': setupFieldLabels.businessPhone,
    'setup-tax-rate-label': setupFieldLabels.taxRate,
    'setup-print-mode-label': setupFieldLabels.printMode,
    'setup-paper-size-label': setupFieldLabels.paperSize,
    'setup-printer-name-label': setupFieldLabels.printer,
    'setup-opening-amount-label': setupFieldLabels.openingAmount,
    'setup-opening-notes-label': setupFieldLabels.openingNotes
  };
  Object.entries(labelMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
  });
  const placeholderMap = {
    'setup-admin-name': setupPlaceholders.adminName,
    'setup-admin-user': setupPlaceholders.adminUser,
    'setup-admin-email': setupPlaceholders.adminEmail,
    'setup-admin-pass': setupPlaceholders.adminPass,
    'setup-business-name': setupPlaceholders.businessName,
    'setup-business-rnc': setupPlaceholders.businessRnc,
    'setup-business-address': setupPlaceholders.businessAddress,
    'setup-business-phone': setupPlaceholders.businessPhone,
    'setup-opening-notes': setupPlaceholders.openingNotes
  };
  Object.entries(placeholderMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && value) el.placeholder = value;
  });
  const optionMap = {
    'setup-print-mode-dialog': setupOptionLabels.printDialog,
    'setup-print-mode-direct': setupOptionLabels.printDirect,
    'setup-paper-size-58': setupOptionLabels.paper58,
    'setup-paper-size-80': setupOptionLabels.paper80,
    'setup-paper-size-a4': setupOptionLabels.paperA4,
    'setup-printer-default-option': setupOptionLabels.defaultPrinter
  };
  Object.entries(optionMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
  });
  if (cashGateTitle) cashGateTitle.textContent = copy.cashGateTitle;
  if (cashGateCopy) cashGateCopy.textContent = copy.cashGateCopy;
  applyAppTranslations();
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
}

function applyAppTranslations() {
  const setTextBySelector = (selector, value) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = value;
  };
  const setPlaceholderBySelector = (selector, value) => {
    const el = document.querySelector(selector);
    if (el) el.placeholder = value;
  };
  document.querySelectorAll('.nav-item').forEach((item) => {
    const moduleName = item.dataset.module;
    const label = item.querySelector('.nav-label');
    if (moduleName && label) label.textContent = appText(`modules.${moduleName}`, label.textContent);
  });
  const activeLabel = document.querySelector('.nav-item.active .nav-label')?.textContent;
  const breadcrumb = document.getElementById('breadcrumb');
  if (breadcrumb && activeLabel) breadcrumb.textContent = activeLabel;
  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn) logoutBtn.textContent = appText('shell.logout', logoutBtn.textContent);

  setTextBySelector('#module-ventas .sales-pizza-mini-title', translateCatalogText('Menú rápido'));
  setTextBySelector('#module-ventas .sale-order-title', translateCatalogText('Pedido actual'));
  setTextBySelector('#module-ventas .sale-order-subtitle', translateCatalogText('Edita cantidades, descuentos o elimina productos antes de cobrar.'));
  setTextBySelector('#module-ventas .btn-cancel', `✖ ${translateCatalogText('Cancelar')}`);
  setTextBySelector('#module-ventas .btn-suspend', `⏸ ${translateCatalogText('Suspender')}`);
  setTextBySelector('#module-ventas .btn-recover', `📂 ${translateCatalogText('Recuperar')}`);
  setTextBySelector('#module-ventas .btn-reprint', `🖨️ ${translateCatalogText('Reimprimir')}`);

  setTextBySelector('#module-productos .module-header h2', translateCatalogText('Gestión de Productos'));
  setPlaceholderBySelector('#products-search', translateCatalogText('Buscar por código, nombre o marca...'));
  const productsStatusOptions = ['Todos', 'Activos', 'Stock bajo', 'Agotados', 'Inactivos'];
  document.querySelectorAll('#products-status-filter option').forEach((option, index) => {
    if (productsStatusOptions[index]) option.textContent = translateCatalogText(productsStatusOptions[index]);
  });
  setTextBySelector('#btn-products-new', `+ ${translateCatalogText('Nuevo Producto')}`);
  setTextBySelector('#btn-products-import', `⬆ ${translateCatalogText('Importar CSV')}`);
  setTextBySelector('#btn-products-export', `⬇ ${translateCatalogText('Exportar')}`);
  setTextBySelector('#btn-products-reload', `↻ ${translateCatalogText('Recargar')}`);
  ['Productos visibles', 'Con stock bajo', 'Agotados', 'Utilidad potencial'].forEach((text, index) => {
    const el = document.querySelectorAll('#module-productos .stat-label')[index];
    if (el) el.textContent = translateCatalogText(text);
  });

  setTextBySelector('#module-inventario .module-header h2', translateCatalogText('Inventario'));
  setPlaceholderBySelector('#inventory-search', translateCatalogText('Buscar por producto o código...'));
  const inventoryStatusOptions = ['Todos', 'Stock bajo', 'Agotados', 'Disponibles'];
  document.querySelectorAll('#inventory-status-filter option').forEach((option, index) => {
    if (inventoryStatusOptions[index]) option.textContent = translateCatalogText(inventoryStatusOptions[index]);
  });
  setTextBySelector('#module-inventario .module-actions .btn-primary', `+ ${translateCatalogText('Ajuste Manual')}`);
  setTextBySelector('#module-inventario .module-actions .btn-secondary', `📋 ${translateCatalogText('Ver Kardex')}`);

  setTextBySelector('#module-proveedores .module-header h2', translateCatalogText('Proveedores'));
  setPlaceholderBySelector('#proveedores-search', translateCatalogText('Buscar proveedor, empresa o RNC...'));
  const supplierHeaderButtons = document.querySelectorAll('#module-proveedores .module-header .btn-primary, #module-proveedores .module-header .btn-secondary');
  if (supplierHeaderButtons[0]) supplierHeaderButtons[0].textContent = `+ ${translateCatalogText('Nuevo Proveedor')}`;
  if (supplierHeaderButtons[1]) supplierHeaderButtons[1].textContent = `+ ${translateCatalogText('Factura')}`;
  const supplierCardHeaders = ['Total Proveedores', 'Activos', 'Facturas Pendientes', 'Facturas Vencidas'];
  document.querySelectorAll('#module-proveedores .report-card-header').forEach((el, index) => {
    if (supplierCardHeaders[index]) el.textContent = translateCatalogText(supplierCardHeaders[index]);
  });
  const supplierCardSubs = ['Registrados en el sistema', 'Disponibles para compras', 'Saldo por pagar', 'Requieren atención'];
  document.querySelectorAll('#module-proveedores .report-card-sub').forEach((el, index) => {
    if (supplierCardSubs[index]) el.textContent = translateCatalogText(supplierCardSubs[index]);
  });
  const supplierPanelTitles = ['Directorio de Proveedores', 'Facturas de Proveedores'];
  document.querySelectorAll('#module-proveedores .proveedores-panel-title').forEach((el, index) => {
    if (supplierPanelTitles[index]) el.textContent = translateCatalogText(supplierPanelTitles[index]);
  });
  const supplierPanelSubs = ['Controla rutas, estado y cuentas por pagar por proveedor.', 'Revisa emisión, vencimiento, pagos y saldos abiertos.'];
  document.querySelectorAll('#module-proveedores .proveedores-panel-subtitle').forEach((el, index) => {
    if (supplierPanelSubs[index]) el.textContent = translateCatalogText(supplierPanelSubs[index]);
  });
  const supplierHeaders1 = ['Proveedor', 'Próxima visita', 'Pendiente', 'Estado', 'Ver'];
  document.querySelectorAll('.proveedores-directory-table thead th').forEach((el, index) => {
    if (supplierHeaders1[index]) el.textContent = translateCatalogText(supplierHeaders1[index]);
  });
  const supplierHeaders2 = ['Proveedor', 'Factura', 'Pendiente', 'Estado', 'Acción'];
  document.querySelectorAll('.proveedores-invoices-table thead th').forEach((el, index) => {
    if (supplierHeaders2[index]) el.textContent = translateCatalogText(supplierHeaders2[index]);
  });

  setTextBySelector('#module-caja .module-header h2', appText('cash.title', 'Gestión de Caja'));
  const cashHeaderButtons = document.querySelectorAll('#module-caja .module-header .btn-primary, #module-caja .module-header .btn-secondary');
  if (cashHeaderButtons[0]) cashHeaderButtons[0].textContent = `↗ ${translateCatalogText('Registrar ingreso')}`;
  if (cashHeaderButtons[1]) cashHeaderButtons[1].textContent = `↘ ${translateCatalogText('Registrar egreso')}`;

  setTextBySelector('#module-reportes .module-header h2', appText('reports.title', 'Reportes'));
  const exportReportBtn = document.querySelector('#module-reportes .module-header .btn-secondary');
  if (exportReportBtn) exportReportBtn.textContent = `⬇ ${appText('reports.exportPdf', 'Exportar PDF')}`;

  setTextBySelector('#module-movimientos .module-header h2', translateCatalogText('Movimientos del Sistema'));
  setPlaceholderBySelector('#movimientos-search', translateCatalogText('Buscar por usuario, módulo o acción...'));
  const movimientosDefaultOption = document.querySelector('#movimientos-module-filter option[value="todos"]');
  if (movimientosDefaultOption) movimientosDefaultOption.textContent = translateCatalogText('Todos los módulos');
  const movCardHeaders = ['Movimientos visibles', 'Movimientos de hoy', 'Usuarios activos'];
  document.querySelectorAll('#module-movimientos .report-card-header').forEach((el, index) => {
    if (movCardHeaders[index]) el.textContent = translateCatalogText(movCardHeaders[index]);
  });
  const movCardSubs = ['Según filtros aplicados', 'Actividad del día', 'Usuarios con movimiento'];
  document.querySelectorAll('#module-movimientos .report-card-sub').forEach((el, index) => {
    if (movCardSubs[index]) el.textContent = translateCatalogText(movCardSubs[index]);
  });
  setTextBySelector('#movimientos-audit-panel .report-panel-head h3', translateCatalogText('Bitácora de auditoría'));
  setTextBySelector('#movimientos-audit-panel .report-panel-head p', translateCatalogText('Acciones del sistema, usuarios y módulos.'));
  ['Fecha', 'Usuario', 'Rol', 'Módulo', 'Acción', 'Detalle'].forEach((text, index) => {
    const el = document.querySelectorAll('#module-movimientos table thead th')[index];
    if (el) el.textContent = translateCatalogText(text);
  });
  const cancelPanelTitle = document.querySelector('#module-movimientos .report-panel[style*="margin-top"] .report-panel-head h3');
  if (cancelPanelTitle) cancelPanelTitle.textContent = translateCatalogText('Cancelar factura');
  const cancelPanelText = document.querySelector('#module-movimientos .report-panel[style*="margin-top"] .report-panel-head p');
  if (cancelPanelText) cancelPanelText.textContent = translateCatalogText('Escribe el código de la factura y valida antes de cancelarla.');
  const cancelLabel = document.querySelector('#module-movimientos .cancel-sale-tool label');
  if (cancelLabel) cancelLabel.textContent = translateCatalogText('Código de factura');
  setPlaceholderBySelector('#cancel-sale-code', translateCatalogText('Ej: FAC-00001014'));
  const cancelSearchButton = document.querySelector('#module-movimientos .cancel-sale-search .btn-primary');
  if (cancelSearchButton) cancelSearchButton.textContent = translateCatalogText('Buscar');

  setTextBySelector('#module-posmovil .module-header h2', translateCatalogText('POS Móvil por WiFi'));
  const posMobileButtons = document.querySelectorAll('#module-posmovil .module-header .btn-primary, #module-posmovil .module-header .btn-secondary');
  if (posMobileButtons[1]) posMobileButtons[1].textContent = `↻ ${translateCatalogText('Actualizar')}`;
  const mobileCardHeaders = ['IP de conexión', 'Sesiones activas', 'Items en móviles'];
  document.querySelectorAll('#module-posmovil .report-card-header').forEach((el, index) => {
    if (mobileCardHeaders[index]) el.textContent = translateCatalogText(mobileCardHeaders[index]);
  });
  const mobileCardSubs = ['Sin detectar', 'Teléfonos conectados', 'Carritos sincronizados'];
  document.querySelectorAll('#module-posmovil .report-card-sub').forEach((el, index) => {
    if (mobileCardSubs[index]) el.textContent = translateCatalogText(mobileCardSubs[index]);
  });
  const mobileSections = ['Conexión', 'Sesiones móviles'];
  document.querySelectorAll('#module-posmovil .config-section h3').forEach((el, index) => {
    if (mobileSections[index]) el.textContent = translateCatalogText(mobileSections[index]);
  });

  setTextBySelector('#module-usuarios .module-header h2', translateCatalogText('Usuarios y Permisos'));
  setTextBySelector('#module-usuarios .module-header .btn-primary', `+ ${translateCatalogText('Nuevo Usuario')}`);
  ['Usuario', 'Nombre', 'Rol', 'Estado', 'Último Acceso', 'Acciones'].forEach((text, index) => {
    const el = document.querySelectorAll('#module-usuarios table thead th')[index];
    if (el) el.textContent = translateCatalogText(text);
  });

  const moduleHeadingMap = {
    '#module-reportes .module-header h2': appText('reports.title', 'Reportes'),
    '#module-configuracion .module-header h2': appText('settings.title', 'Configuración General')
  };
  Object.entries(moduleHeadingMap).forEach(([selector, value]) => {
    const el = document.querySelector(selector);
    if (el) el.textContent = value;
  });
  const saveConfigBtn = document.querySelector('#module-configuracion .module-header .btn-primary');
  if (saveConfigBtn) saveConfigBtn.textContent = `💾 ${appText('settings.save', 'Guardar Cambios')}`;
  const clientsHeading = document.querySelector('#module-clientes .module-header h2');
  if (clientsHeading) clientsHeading.textContent = translateCatalogText('Clientes');
  const clientsSearch = document.querySelector('#module-clientes .mod-search');
  if (clientsSearch) clientsSearch.placeholder = translateCatalogText('Buscar cliente...');
  const clientsNewButton = document.querySelector('#module-clientes .module-header .btn-primary');
  if (clientsNewButton) clientsNewButton.textContent = `+ ${translateCatalogText('Nuevo Cliente')}`;
  const clientsHeaders = ['Nombre', 'Teléfono', 'Referencia', 'Mapa', 'Cédula/RNC', 'Balance', 'Límite Crédito', 'Acciones'];
  document.querySelectorAll('#clientes-table thead th').forEach((th, index) => {
    th.textContent = translateCatalogText(clientsHeaders[index] || th.textContent);
  });
  const settingsIdMap = {
    'cfg-section-business-title': appText('settings.businessSection', 'Datos del Negocio'),
    'cfg-label-business-name': appText('settings.businessName', 'Nombre del Negocio'),
    'cfg-label-app-logo': appText('settings.appLogo', 'Logo de la App'),
    'cfg-btn-upload-logo': `🖼 ${appText('settings.uploadLogo', 'Cargar logo')}`,
    'cfg-btn-remove-logo': `🗑 ${appText('settings.removeLogo', 'Quitar logo')}`,
    'cfg-label-rnc': appText('settings.rnc', 'RNC / Cédula'),
    'cfg-label-address': appText('settings.address', 'Dirección'),
    'cfg-label-phone': appText('settings.phone', 'Teléfono'),
    'cfg-label-business-type': appText('settings.businessType', 'Tipo de negocio'),
    'cfg-label-business-structure': appText('settings.businessStructure', 'Modo de operación'),
    'cfg-label-base-language': appText('settings.baseLanguage', 'Idioma base'),
    'cfg-section-branches-title': appText('settings.branchesSection', 'Sucursales y cajas'),
    'cfg-label-active-branch': appText('settings.activeBranch', 'Sucursal activa'),
    'cfg-label-active-cash-register': appText('settings.activeCashRegister', 'Caja activa'),
    'cfg-btn-apply-branch-setup': `🏢 ${appText('settings.applyBranchStructure', 'Aplicar sucursal y caja')}`,
    'cfg-branch-helper': appText('settings.branchHelper', 'Las aperturas, cierres, ingresos, egresos y ventas nuevas se registrarán en la sucursal y caja activas.'),
    'cfg-label-cashier-register-required': appText('settings.cashierRegisterRequired', 'Caja obligatoria para cajeros'),
    'cfg-cashier-register-required-helper': appText('settings.cashierRegisterRequiredHelper', 'Cuando esté activa, el formulario Nuevo Usuario exigirá una caja para roles de cajero en multicaja y multisucursal.'),
    'cfg-label-exclusive-cashier-register': appText('settings.exclusiveCashierRegister', 'Asignación exclusiva por caja'),
    'cfg-exclusive-cashier-register-helper': appText('settings.exclusiveCashierRegisterHelper', 'Evita crear dos cajeros activos con la misma caja fija.'),
    'cfg-label-new-branch': appText('settings.newBranch', 'Nueva sucursal'),
    'cfg-btn-create-branch': `+ ${appText('settings.createBranch', 'Crear sucursal')}`,
    'cfg-label-new-cash-register': appText('settings.newCashRegister', 'Nueva caja'),
    'cfg-btn-create-cash-register': `+ ${appText('settings.createCashRegister', 'Crear caja')}`,
    'cfg-section-billing-title': appText('settings.billingSection', 'Facturación'),
    'cfg-label-currency': appText('settings.currency', 'Moneda'),
    'cfg-label-tax': appText('settings.tax', 'ITBIS (%)'),
    'cfg-label-prefix': appText('settings.invoicePrefix', 'Prefijo Factura'),
    'cfg-label-next-ticket': appText('settings.nextTicket', 'Próximo Ticket'),
    'cfg-label-einvoice-toggle': appText('settings.eInvoiceToggle', 'Habilitar factura electrónica'),
    'cfg-label-e-prefix': appText('settings.eInvoicePrefix', 'Prefijo Factura Electrónica'),
    'cfg-label-next-einvoice': appText('settings.nextEInvoice', 'Próxima Factura Electrónica'),
    'cfg-label-receipt-message': appText('settings.receiptMessage', 'Mensaje en Recibo'),
    'cfg-label-print-method': appText('settings.printMethod', 'Método de impresión'),
    'cfg-option-print-dialog': appText('settings.printDialog', 'Mostrar diálogo antes de imprimir'),
    'cfg-option-print-direct': appText('settings.printDirect', 'Imprimir directo a la impresora'),
    'cfg-label-paper-size': appText('settings.paperSize', 'Tamaño del papel'),
    'cfg-option-paper-58': appText('cash.paper58', 'Ticket térmico 58mm'),
    'cfg-option-paper-80': appText('cash.paper80', 'Ticket térmico 80mm'),
    'cfg-option-paper-a4': appText('cash.paperA4', 'Carta / A4'),
    'cfg-label-printer': appText('settings.printer', 'Impresora de facturas'),
    'cfg-printer-default-option': appText('cash.defaultPrinter', 'Usar impresora predeterminada'),
    'cfg-btn-refresh-printers': `↻ ${appText('settings.refreshPrinters', 'Actualizar')}`,
    'cfg-printer-helper': appText('settings.printerHelper', 'Puedes elegir la impresora térmica o dejar la predeterminada del sistema.'),
    'cfg-label-preview': appText('settings.preview', 'Vista previa'),
    'cfg-btn-print-preview': `👁️ ${appText('settings.previewButton', 'Vista previa de impresión')}`,
    'cfg-preview-helper': appText('settings.previewHelper', 'Revisa cómo se verá el ticket antes de cobrar o hacer una impresión real.'),
    'cfg-section-appearance-title': appText('settings.appearanceSection', 'Apariencia'),
    'cfg-label-theme': appText('settings.theme', 'Tema'),
    'cfg-option-theme-dark': appText('settings.themeDark', 'Oscuro'),
    'cfg-option-theme-light': appText('settings.themeLight', 'Claro'),
    'cfg-label-sales-split-view': appText('settings.salesSplitView', 'Vista dividida en ventas'),
    'cfg-sales-split-view-helper': appText('settings.salesSplitViewHelper', 'Muestra el catálogo de productos a un lado y el pedido actual al otro para trabajar en pantalla dividida.'),
    'cfg-label-primary-color': appText('settings.primaryColor', 'Color Primario'),
    'cfg-label-license-status': appText('settings.licenseStatus', 'Estado de licencia'),
    'cfg-btn-license-refresh': `↻ ${appText('settings.licenseRefresh', 'Actualizar estado')}`,
    'cfg-btn-license-whatsapp': `💬 ${appText('settings.licenseWhatsapp', 'Verificar por WhatsApp')}`,
    'cfg-business-guide-heading': appText('settings.businessGuideHeading', 'Guía del Negocio'),
    'cfg-business-guide-title': appText('settings.businessGuideTitle', 'Guía rápida del negocio'),
    'cfg-section-backup-title': appText('settings.backupSection', 'Respaldo'),
    'cfg-label-backup-copy': appText('settings.backupLabel', 'Copia de seguridad'),
    'cfg-backup-copy-text': appText('settings.backupText', 'Al cerrar la app se guarda automáticamente una copia segura cifrada en una carpeta protegida. También puedes exportar un respaldo manual en JSON.'),
    'cfg-btn-export-backup': `⬇ ${appText('settings.backupDownload', 'Descargar copia')}`,
    'cfg-btn-restore-backup': `🔐 ${appText('settings.backupRestore', 'Restaurar copia segura')}`,
    'cfg-btn-open-backup-folder': `📁 ${appText('settings.backupFolder', 'Abrir carpeta segura')}`,
    'cfg-section-access-title': appText('settings.accessSection', 'Acceso de la cuenta'),
    'cfg-label-access-user': appText('settings.accessUser', 'Usuario de acceso'),
    'cfg-label-access-methods': appText('settings.accessMethods', 'Métodos disponibles'),
    'cfg-label-access-password': appText('settings.accessPassword', 'Contraseña de acceso'),
    'cfg-section-security-title': appText('settings.securitySection', 'Seguridad'),
    'cfg-label-security-key': appText('settings.securityLabel', 'Clave de seguridad'),
    'cfg-security-text': appText('settings.securityText', 'Esta clave protege la restauración de copia segura, la apertura de la carpeta segura y la acción de eliminar todo.'),
    'cfg-btn-change-security': `🔐 ${appText('settings.securityChange', 'Cambiar clave')}`,
    'cfg-btn-reset-security': `↺ ${appText('settings.securityReset', 'Restablecer a fábrica')}`,
    'cfg-section-danger-title': appText('settings.dangerSection', 'Zona de Peligro'),
    'cfg-label-danger-delete': appText('settings.dangerLabel', 'Eliminar todo'),
    'cfg-danger-text': appText('settings.dangerText', 'Borra los datos locales del sistema y, si lo confirmas, también puede eliminar la información remota del negocio en Firebase. Antes de hacerlo, el sistema guarda una copia segura automática.'),
    'cfg-btn-delete-all': `🗑 ${appText('settings.dangerButton', 'Eliminar todo')}`
  };
  Object.entries(settingsIdMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  const loginLicenseRefresh = document.getElementById('login-license-refresh');
  if (loginLicenseRefresh) loginLicenseRefresh.textContent = appText('settings.licenseRefresh', 'Actualizar estado');
  const loginLicenseWhatsapp = document.getElementById('login-license-whatsapp');
  if (loginLicenseWhatsapp) loginLicenseWhatsapp.textContent = appText('settings.licenseWhatsapp', 'Verificar por WhatsApp');

  const reportPeriod = document.getElementById('reporte-periodo');
  if (reportPeriod) {
    const labels = [appText('reports.today', 'Hoy'), appText('reports.week', 'Esta Semana'), appText('reports.month', 'Este Mes'), appText('reports.year', 'Este Año')];
    [...reportPeriod.options].forEach((option, index) => {
      if (labels[index]) option.textContent = labels[index];
    });
  }

  const reportCardHeaders = document.querySelectorAll('#module-reportes .report-card-header');
  const reportCardTitles = [
    appText('reports.totalSales', 'Total Ventas'),
    appText('reports.profits', 'Ganancias'),
    appText('reports.topProduct', 'Producto Más Vendido'),
    appText('reports.taxCollected', 'ITBIS Recaudado')
  ];
  reportCardHeaders.forEach((el, index) => {
    if (reportCardTitles[index]) el.textContent = reportCardTitles[index];
  });
  const reportCardSubs = document.querySelectorAll('#module-reportes .report-card-sub');
  if (reportCardSubs[1]) reportCardSubs[1].textContent = appText('reports.afterCosts', 'Después de costos');
  const reportPanelHeadings = document.querySelectorAll('#module-reportes .report-panel-head h3');
  const reportPanelTexts = document.querySelectorAll('#module-reportes .report-panel-head p');
  const panelTitles = [
    appText('reports.trendTitle', 'Tendencia de ventas'),
    appText('reports.paymentMethods', 'Métodos de pago'),
    appText('reports.topProducts', 'Top productos'),
    appText('reports.orderTypes', 'Tipos de pedido'),
    appText('reports.operations', 'Rendimiento operativo'),
    appText('reports.history', 'Historial de Ventas')
  ];
  const panelTexts = [
    appText('reports.trendText', 'Comportamiento del periodo seleccionado.'),
    appText('reports.paymentText', 'Participación por canal de cobro.'),
    appText('reports.topProductsText', 'Lo más vendido en el periodo.'),
    appText('reports.orderTypesText', 'Mostrador, delivery, recoger o mesa.'),
    appText('reports.operationsText', 'Lectura rápida para tomar decisiones.'),
    appText('reports.historyText', 'Detalle de facturas emitidas en el periodo.')
  ];
  reportPanelHeadings.forEach((el, index) => {
    if (panelTitles[index]) el.textContent = panelTitles[index];
  });
  reportPanelTexts.forEach((el, index) => {
    if (panelTexts[index]) el.textContent = panelTexts[index];
  });
  const reportTableHeaders = document.querySelectorAll('#module-reportes table thead th');
  const reportHeaderTitles = [
    appText('reports.invoice', 'Factura'),
    appText('reports.type', 'Tipo'),
    appText('reports.date', 'Fecha'),
    appText('reports.client', 'Cliente'),
    appText('reports.cashier', 'Cajero'),
    appText('reports.method', 'Método'),
    appText('reports.total', 'Total'),
    appText('reports.action', 'Acción')
  ];
  reportTableHeaders.forEach((el, index) => {
    if (reportHeaderTitles[index]) el.textContent = reportHeaderTitles[index];
  });

  const cashStatus = document.getElementById('caja-status-text');
  if (cashStatus) cashStatus.textContent = cajaAbierta ? appText('cash.open', 'Caja Abierta') : appText('cash.closed', 'Caja Cerrada');
  const cashBtn = document.getElementById('btn-caja-action');
  if (cashBtn) {
    // Cuando la caja está abierta, ocultar el botón — solo se puede cerrar por Corte de Caja
    cashBtn.style.display = cajaAbierta ? 'none' : '';
    cashBtn.textContent = appText('cash.openAction', 'Abrir Caja');
  }
  const cashHint = document.getElementById('caja-action-hint');
  if (cashHint) {
    // Cuando la caja está abierta, ocultar también el hint (el botón no existe)
    cashHint.style.display = cajaAbierta ? 'none' : '';
    if (!cajaAbierta) cashHint.textContent = appText('cash.openHint', 'Indica el monto inicial y deja una nota para la apertura.');
  }
  const cashAmountLabel = document.querySelector('#module-caja label[for="caja-input-monto"], #module-caja .caja-form .form-group:first-child label');
  if (cashAmountLabel) cashAmountLabel.textContent = appText('cash.amountLabel', 'Monto Inicial / Final');
  const cashNotesLabel = document.querySelector('#module-caja .caja-form .form-group:nth-child(2) label');
  if (cashNotesLabel) cashNotesLabel.textContent = appText('cash.notesLabel', 'Observaciones');
  const cashNotes = document.getElementById('caja-obs');
  if (cashNotes) cashNotes.placeholder = appText('cash.notesPlaceholder', 'Notas...');
  const cashHeads = document.querySelectorAll('#module-caja .caja-egresos-head h3');
  const cashTexts = document.querySelectorAll('#module-caja .caja-egresos-head p');
  if (cashHeads[0]) cashHeads[0].textContent = appText('cash.expenseTitle', 'Registro de Egresos');
  if (cashTexts[0]) cashTexts[0].textContent = appText('cash.expenseText', 'Controla todo lo que sale de caja sin mezclarlo con las ventas.');
  if (cashHeads[1]) cashHeads[1].textContent = appText('cash.incomeTitle', 'Registro de Ingresos');
  if (cashTexts[1]) cashTexts[1].textContent = appText('cash.incomeText', 'Usa este ingreso cuando te lleven dinero aparte que no viene de una venta normal.');
  const incomeBtn = document.querySelector('#module-caja .caja-income-row .btn-primary');
  if (incomeBtn) incomeBtn.textContent = appText('cash.incomeButton', 'Registrar ingreso');
  const movLists = document.querySelectorAll('#module-caja .movimientos-list h3');
  if (movLists[0]) movLists[0].textContent = appText('cash.pendingDelivery', 'Contra entrega pendiente');
  if (movLists[1]) movLists[1].textContent = appText('cash.movements', 'Movimientos');
  const deliveryEmpty = document.querySelector('#delivery-cash-pending-list .text-muted');
  if (deliveryEmpty) deliveryEmpty.textContent = appText('cash.pendingDeliveryEmpty', deliveryEmpty.textContent);
  const cajaResumenTitle = document.querySelector('#module-caja .caja-resumen h3');
  if (cajaResumenTitle) cajaResumenTitle.textContent = appText('cash.daySummary', 'Resumen del Día');
  const resumenRows = document.querySelectorAll('#module-caja .caja-resumen .resumen-row span:first-child');
  const resumenTitles = [
    appText('cash.cashSales', 'Ventas en Efectivo'),
    appText('cash.cardSales', 'Ventas con Tarjeta'),
    appText('cash.transferSales', 'Transferencias'),
    appText('cash.totalSales', 'Total Ventas'),
    appText('cash.expenses', 'Gastos')
  ];
  resumenRows.forEach((el, index) => {
    if (resumenTitles[index]) el.textContent = resumenTitles[index];
  });
  const resumenTotal = document.querySelector('#module-caja .resumen-total span:first-child');
  if (resumenTotal) resumenTotal.textContent = appText('cash.finalBalance', 'Balance Final');
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
}

function renderStartupLanguageOptions() {
  const languages = getAvailableLanguages();
  const options = languages.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
  ['login-language-select'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = options;
    select.value = setupWizard.language || 'es';
  });
}

function changeStartupLanguage(language) {
  setupWizard.language = language || 'es';
  DB.config.idioma = setupWizard.language;
  renderStartupLanguageOptions();
  updateStaticUiTexts();
  if (!document.getElementById('setup-screen')?.classList.contains('hidden')) {
    renderSetupWizard();
  }
}

function showLoginScreen() {
  startLicenseWatcher();
  document.getElementById('setup-screen')?.classList.add('hidden');
  document.getElementById('login-screen')?.classList.remove('hidden');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app')?.classList.add('hidden');
  document.getElementById('cash-gate-screen')?.classList.add('hidden');
  renderStartupLanguageOptions();
  applyRememberedLoginUser();
  setLoginMode(setupState?.setupRequired ? 'new' : 'existing');
  if (!setupState?.setupRequired) {
    setTimeout(() => document.getElementById(getLastLoginUser() ? 'login-pass' : 'login-user')?.focus(), 0);
  }
}

function normalizePhoneForWhatsApp(rawPhone, defaultCountryCode = '1') {
  let clean = String(rawPhone || '').replace(/[^\d+]/g, '').replace(/\+/g, '');
  if (clean.length === 10) clean = `${defaultCountryCode}${clean}`;
  return clean;
}

function getLicenseSupportPhone() {
  return normalizePhoneForWhatsApp(
    DB.config?.telefono
      || setupState?.config?.telefono
      || DEFAULT_LICENSE_WHATSAPP
  );
}

function getLicenseSupportMessage() {
  const status = String(DB.config?.licenseStatus || 'trial').trim().toLowerCase();
  const businessName = String(DB.config?.nombre || setupState?.config?.nombre || 'Tecno Caja').trim();
  const currentUser = DB.currentUser || {};
  const attemptedUser = String(document.getElementById('login-user')?.value || '').trim();
  const userLabel = String(currentUser.nombre || currentUser.usuario || attemptedUser || 'Sin usuario');
  const emailLabel = String(currentUser.email || '').trim() || 'No registrado';
  const daysLeft = Number(DB.config?.trialDaysLeft || 0);

  if (status === 'suspended') {
    return [
      'Hola, necesito verificar la licencia de mi POS porque aparece SUSPENDIDA y no me deja entrar.',
      `Negocio: ${businessName}`,
      `Usuario: ${userLabel}`,
      `Correo: ${emailLabel}`,
      'Podrían ayudarme a restaurar el acceso?'
    ].join('\n');
  }

  return [
    'Hola, necesito activar o verificar la licencia de mi POS.',
    `Negocio: ${businessName}`,
    `Usuario: ${userLabel}`,
    `Correo: ${emailLabel}`,
    `Estado: ${status === 'active' ? 'active' : (DB.config?.trialExpired ? 'expired' : 'trial')}`,
    `Dias restantes: ${daysLeft}`,
    'Podrían ayudarme por favor?'
  ].join('\n');
}

async function openLicenseWhatsAppSupport() {
  const phone = getLicenseSupportPhone();
  if (!phone) {
    showToast(appText('license.whatsappMissingNumber', 'Configura el teléfono del negocio para usar WhatsApp.'), 'warning');
    return;
  }

  const encoded = encodeURIComponent(getLicenseSupportMessage());
  const candidates = [
    `https://wa.me/${phone}?text=${encoded}`,
    `https://api.whatsapp.com/send?phone=${phone}&text=${encoded}`
  ];

  let opened = false;
  for (const candidate of candidates) {
    try {
      if (window.novaDesktop?.openExternal) {
        await window.novaDesktop.openExternal(candidate);
      } else {
        window.open(candidate, '_blank', 'noopener,noreferrer');
      }
      opened = true;
      break;
    } catch (_error) {
      // try next URL
    }
  }

  if (!opened) {
    showToast(appText('license.whatsappOpenError', 'No se pudo abrir WhatsApp en este dispositivo.'), 'error');
  }
}

async function openWhatsAppWeb(targetUrl = 'https://web.whatsapp.com/') {
  const url = String(targetUrl || 'https://web.whatsapp.com/').trim() || 'https://web.whatsapp.com/';
  if (window.novaDesktop?.openWhatsAppWeb) {
    try {
      const result = await window.novaDesktop.openWhatsAppWeb(url);
      if (!result?.ok) {
        showToast(result?.error || 'No se pudo abrir WhatsApp Web.', 'error');
      }
      return;
    } catch (_error) {
      // Some desktop builds expose the preload bridge but not the IPC handler yet.
    }
  }

  if (window.novaDesktop?.openExternal) {
    const result = await window.novaDesktop.openExternal(url);
    if (!result?.ok) {
      showToast(result?.error || 'No se pudo abrir WhatsApp Web.', 'error');
    }
    return;
  }

  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (_error) {
    showToast('No se pudo abrir WhatsApp Web.', 'error');
  }
}

function canOpenWhatsAppShortcut() {
  return Boolean(window.novaDesktop?.openWhatsAppWeb) || typeof window.open === 'function';
}

function syncWhatsAppButtons(enabled = DB.config?.whatsappWebEnabled) {
  const shouldShow = Boolean(enabled) && canOpenWhatsAppShortcut();
  const button = document.getElementById('topbar-whatsapp');
  if (button) button.classList.toggle('hidden', !shouldShow);
}

async function handleWhatsAppWebToggle(forceChecked = null) {
  const whatsappToggle = document.getElementById('cfg-whatsapp-web-enabled');
  const nextEnabled = typeof forceChecked === 'boolean'
    ? forceChecked
    : Boolean(whatsappToggle?.checked);
  const previousEnabled = Boolean(DB.config?.whatsappWebEnabled);

  if (whatsappToggle) whatsappToggle.checked = nextEnabled;
  DB.config = { ...DB.config, whatsappWebEnabled: nextEnabled };
  syncWhatsAppButtons(nextEnabled);

  try {
    const config = await api.saveConfig({
      ...DB.config,
      whatsappWebEnabled: nextEnabled,
      ...getActorPayload()
    });
    DB.config = { ...DB.config, ...config };
    if (whatsappToggle) whatsappToggle.checked = Boolean(DB.config?.whatsappWebEnabled);
    syncWhatsAppButtons(DB.config?.whatsappWebEnabled);
    showToast(nextEnabled ? 'WhatsApp Web activado correctamente.' : 'WhatsApp Web desactivado correctamente.', 'success');
  } catch (error) {
    DB.config = { ...DB.config, whatsappWebEnabled: previousEnabled };
    if (whatsappToggle) whatsappToggle.checked = previousEnabled;
    syncWhatsAppButtons(previousEnabled);
    showToast(error.message || 'No se pudo actualizar WhatsApp Web.', 'error');
  }
}

async function refreshStartupStatus(showFeedback = true) {
  try {
    setupState = await api.getSetupStatus();
    if (setupState?.config) {
      DB.config = { ...DB.config, ...setupState.config };
    }
    setupWizard.language = DB.config?.idioma || 'es';
    setupWizard.businessType = DB.config?.tipoNegocio || 'pizzeria';
    setupWizard.businessStructureMode = normalizeBusinessStructureMode(DB.config?.businessStructureMode);
    updateStaticUiTexts();
    applyBranding();
    applyBusinessProfile();
    updateLicenseUI();
    if (showFeedback) {
      showToast('Estado de licencia actualizado.', 'success');
    }
  } catch (error) {
    if (showFeedback) {
      showToast(error.message || 'No se pudo actualizar el estado de la licencia.', 'error');
    }
  }
}

function hasGoogleSetupAuth() {
  return Boolean(setupWizard.googleAuth?.idToken);
}

function applyGoogleSetupPrefill() {
  const googleName = document.getElementById('setup-admin-name');
  const googleEmail = document.getElementById('setup-admin-email');
  const googlePassword = document.getElementById('setup-admin-pass');
  const googleNote = document.getElementById('setup-google-auth-note');
  const passHelp = document.getElementById('setup-admin-pass-help');
  const copy = getUiText();
  const active = hasGoogleSetupAuth();
  const translatedOptionalPlaceholder = typeof window.translateUiString === 'function'
    ? window.translateUiString('Opcional si quieres entrar también con usuario y contraseña', getCurrentLanguage())
    : 'Opcional si quieres entrar también con usuario y contraseña';
  const translatedMinPlaceholder = copy.setupPlaceholders?.adminPass || 'Mínimo 4 caracteres';
  const fallbackGoogleName = setupWizard.googleAuth?.name
    || (setupWizard.googleAuth?.email || '').split('@')[0]
    || '';

  if (googleName) {
    if (active) googleName.value = fallbackGoogleName || googleName.value || '';
    googleName.readOnly = active && Boolean(googleName.value);
  }
  if (googleEmail) {
    if (active) googleEmail.value = setupWizard.googleAuth.email || googleEmail.value || '';
    googleEmail.readOnly = active && Boolean(googleEmail.value);
  }
  if (googlePassword) {
    googlePassword.placeholder = active
      ? translatedOptionalPlaceholder
      : translatedMinPlaceholder;
  }
  if (passHelp) {
    passHelp.textContent = active
      ? (typeof window.translateUiString === 'function'
          ? window.translateUiString('Puedes dejarla en blanco por ahora y crearla luego desde Configuración.', getCurrentLanguage())
          : 'Puedes dejarla en blanco por ahora y crearla luego desde Configuración.')
      : (typeof window.translateUiString === 'function'
          ? window.translateUiString('Opcional solo si luego quieres entrar también con usuario y contraseña.', getCurrentLanguage())
          : 'Opcional solo si luego quieres entrar también con usuario y contraseña.');
  }
  if (googleNote) {
    googleNote.classList.toggle('hidden', !active);
    if (active) {
      googleNote.innerHTML = `<strong>${copy.setupGoogleLinkedTitle || 'Cuenta Google vinculada'}</strong><br>${copy.setupGoogleLinkedText || ''}<br><span style="color:var(--text);display:block;margin-top:0.45rem">${setupWizard.googleAuth.email}</span>`;
    } else {
      googleNote.innerHTML = '';
    }
  }
}

function beginGoogleSetup(googleSession) {
  const displayName = String(googleSession.name || '').trim()
    || String(googleSession.email || '').split('@')[0]
    || '';
  setupWizard.forceReset = false;
  setupWizard.securityPassword = '';
  setupWizard.step = 0;
  setupWizard.language = document.getElementById('login-language-select')?.value || setupWizard.language || DB.config?.idioma || 'es';
  setupWizard.businessType = 'pizzeria';
  setupWizard.businessStructureMode = normalizeBusinessStructureMode(DB.config?.businessStructureMode);
  setupWizard.googleAuth = {
    idToken: googleSession.idToken,
    email: googleSession.email || '',
    name: displayName
  };
  DB.config.idioma = setupWizard.language;
  resetSetupFormFields(false);
  const adminUser = document.getElementById('setup-admin-user');
  if (adminUser && !adminUser.value) {
    adminUser.value = (googleSession.email || '')
      .split('@')[0]
      .replace(/[^a-zA-Z0-9._-]+/g, '')
      .toLowerCase()
      .slice(0, 24);
  }
  updateStaticUiTexts();
  showSetupScreen();
  renderSetupWizard();
  refreshSetupPrinterOptions();
  setTimeout(() => document.getElementById('setup-admin-user')?.focus(), 0);
}

function showSetupScreen() {
  document.getElementById('login-screen')?.classList.add('hidden');
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('setup-screen')?.classList.remove('hidden');
  document.getElementById('app')?.classList.add('hidden');
}

function setLoginMode(mode = 'existing') {
  const existingAllowed = !setupState?.setupRequired;
  loginMode = mode === 'new' ? 'new' : 'existing';
  if (!existingAllowed && loginMode === 'existing') {
    loginMode = 'new';
  }
  const existingBtn = document.getElementById('login-mode-existing');
  const newBtn = document.getElementById('login-mode-new');
  const existingPanel = document.getElementById('login-existing-panel');
  const newPanel = document.getElementById('login-new-panel');
  const loginHint = document.getElementById('login-hint');
  const copy = getUiText();
  if (existingBtn) existingBtn.disabled = !existingAllowed;
  existingBtn?.classList.toggle('active', loginMode === 'existing');
  newBtn?.classList.toggle('active', loginMode === 'new');
  existingPanel?.classList.toggle('hidden', loginMode !== 'existing');
  newPanel?.classList.toggle('hidden', loginMode !== 'new');
  if (loginHint) {
    loginHint.textContent = !existingAllowed
      ? copy.loginHintSetupRequired
      : loginMode === 'new'
        ? copy.loginNewText
        : copy.loginHint;
  }
  if (loginMode === 'existing') {
    setTimeout(() => document.getElementById(getLastLoginUser() ? 'login-pass' : 'login-user')?.focus(), 0);
  }
}

function getConfiguredAppSetupMessage() {
  return 'Esta instalacion ya esta configurada. Si solo necesitas otro usuario, entra con una cuenta administradora y crealo desde Usuarios. Si quieres reemplazar el negocio actual, usa "Reinstalar una app existente".';
}

async function startNewUserFlow() {
  if (!setupState) {
    try {
      setupState = await api.getSetupStatus();
      if (setupState?.config) {
        DB.config = { ...DB.config, ...setupState.config };
      }
    } catch (_) {
      // Si la API falla, abrir wizard igual con datos mínimos
    }
  }
  if (setupState?.setupRequired !== false) {
    startSetupWizardSession();
    return;
  }
  showToast(getConfiguredAppSetupMessage(), 'warning');
  launchSetupWizardFromLogin();
}

function startSetupWizardSession({ preserveGoogle = false, forceReset = false, securityPassword = '' } = {}) {
  setupWizard.forceReset = false;
  setupWizard.forceReset = Boolean(forceReset);
  setupWizard.securityPassword = securityPassword || '';
  setupWizard.step = 0;
  if (!preserveGoogle) setupWizard.googleAuth = null;
  setupWizard.language = document.getElementById('login-language-select')?.value || setupWizard.language || DB.config?.idioma || 'es';
  DB.config.idioma = setupWizard.language;
  setupWizard.businessType = 'pizzeria';
  setupWizard.businessStructureMode = normalizeBusinessStructureMode(DB.config?.businessStructureMode);
  resetSetupFormFields(!preserveGoogle);
  updateStaticUiTexts();
  if (typeof window.wzReset === 'function') window.wzReset();
  showSetupScreen();
  renderSetupWizard();
  refreshSetupPrinterOptions();
}

function resetSetupFormFields(clearGoogle = true) {
  if (clearGoogle) {
    setupWizard.googleAuth = null;
  }
  const defaults = {
    'setup-admin-name': '',
    'setup-admin-user': '',
    'setup-admin-email': '',
    'setup-admin-pass': '',
    'setup-business-name': '',
    'setup-business-rnc': '',
    'setup-business-address': '',
    'setup-business-phone': '',
    'setup-opening-notes': ''
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  const taxRate = document.getElementById('setup-tax-rate');
  if (taxRate) taxRate.value = '18';
  const currency = document.getElementById('setup-currency');
  if (currency) currency.value = 'RD$';
  const printMode = document.getElementById('setup-print-mode');
  if (printMode) printMode.value = 'dialog';
  const paperSize = document.getElementById('setup-paper-size');
  if (paperSize) paperSize.value = '80mm';
  const printer = document.getElementById('setup-printer-name');
  if (printer) printer.value = '';
  const openingAmount = document.getElementById('setup-opening-amount');
  if (openingAmount) openingAmount.value = '0';
}

// Long press timer for factory reset
let longPressTimer = null;
let longPressActivated = false;

function startLongPressTimer() {
  clearLongPressTimer();
  longPressActivated = false;
  longPressTimer = setTimeout(() => {
    longPressActivated = true;
    executeFactoryReset();
  }, 3000); // 3 seconds long press
}

function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function handleLoginNewClick() {
  if (longPressActivated) {
    longPressActivated = false;
    return;
  }
  startNewUserFlow();
}

function executeFactoryReset() {
  openFactoryResetModal();
}

function openFactoryResetModal() {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) return;

  title.textContent = 'Reset completo';
  body.innerHTML = `
    <div class="form-group">
      <label>Confirmación obligatoria</label>
      <p style="color:var(--danger);font-size:0.85rem;line-height:1.5;margin-bottom:0.75rem">
        Esto eliminará TODOS los datos del negocio, la licencia, configuración y usuarios. No se puede deshacer.
      </p>
      <input type="text" id="factory-reset-confirmation" class="form-input" placeholder="Escribe ELIMINAR TODO">
    </div>
    <div class="form-group">
      <label>Clave de seguridad</label>
      <div class="password-field">
        <input type="password" id="factory-reset-password" class="form-input" placeholder="Escribe la clave de seguridad">
        <button class="password-toggle" type="button" onclick="togglePasswordVisibility('factory-reset-password', this)" aria-label="Mostrar clave">👁</button>
      </div>
    </div>
    <div class="form-group">
      <label>Confirmación remota</label>
      <input type="text" id="factory-reset-cloud-confirmation" class="form-input" placeholder="Escribe BORRAR FIREBASE">
      <p style="color:var(--text2);font-size:0.82rem;line-height:1.5;margin-top:0.5rem">
        Esto también borrará la licencia y la información sincronizada en Firebase. Solo hazlo si quieres empezar desde cero completo.
      </p>
    </div>
    <div id="factory-reset-status" style="color:var(--text2);font-size:0.84rem;margin-top:0.75rem"></div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="submitFactoryResetModal()" style="background:var(--danger)">Eliminar todo</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('factory-reset-confirmation')?.focus(), 0);
}

async function submitFactoryResetModal() {
  const confirmationInput = document.getElementById('factory-reset-confirmation');
  const passwordInput = document.getElementById('factory-reset-password');
  const cloudConfirmationInput = document.getElementById('factory-reset-cloud-confirmation');
  const status = document.getElementById('factory-reset-status');

  const confirmation = confirmationInput?.value?.trim().toUpperCase() || '';
  const password = passwordInput?.value?.trim() || '';
  const cloudConfirmation = cloudConfirmationInput?.value?.trim().toUpperCase() || '';

  if (confirmation !== 'ELIMINAR TODO') {
    if (status) status.textContent = 'Debes escribir ELIMINAR TODO para confirmar.';
    return;
  }
  if (!password) {
    if (status) status.textContent = 'Debes ingresar la clave de seguridad.';
    return;
  }
  if (cloudConfirmation !== 'BORRAR FIREBASE') {
    if (status) status.textContent = 'Debes escribir BORRAR FIREBASE para borrar la nube.';
    return;
  }

  if (status) status.textContent = 'Ejecutando reset completo...';

  try {
    const response = await api.resetSystem({
      confirmation,
      password,
      purgeFirebase: true,
      cloudConfirmation,
      factoryReset: true,
      actorUserId: 1,
      actorUserName: 'Factory Reset',
      actorUserRole: 'Administrador'
    });

    closeAllModals();
    if (response.firebasePurged) {
      showToast('Reset completo realizado. La aplicación se reiniciará.', 'success');
      setTimeout(() => window.location.reload(), 2000);
      return;
    }
    showToast('Reset realizado parcialmente. Reinicia la aplicación.', 'warning');
    setTimeout(() => window.location.reload(), 2000);
  } catch (error) {
    if (status) status.textContent = error.message || 'No se pudo ejecutar el reset.';
    showToast('Error durante el reset: ' + (error.message || 'Error desconocido'), 'error');
  }
}

function launchSetupWizardFromLogin(options = {}) {
  const googleSession = options.googleSession || null;
  const hasGoogleSession = Boolean(googleSession?.idToken);
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) return;

  title.textContent = 'Reinstalar aplicación';
  body.innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full">
        <label>Clave de seguridad</label>
        <p style="color:var(--text2);font-size:0.84rem;line-height:1.5;margin-bottom:0.7rem">
          ${hasGoogleSession
            ? 'Validaremos la clave de seguridad y luego abriremos el asistente con tu cuenta Google ya vinculada al nuevo negocio.'
            : 'Esto abrirá el asistente de primer inicio y al finalizar reemplazará la configuración y los datos actuales.'}
        </p>
        ${hasGoogleSession ? `<input type="text" class="form-input" value="${googleSession.email || googleSession.name || 'Cuenta Google seleccionada'}" disabled style="margin-bottom:0.75rem">` : ''}
        <div class="password-field">
          <input type="password" id="setup-reinstall-password" class="form-input" placeholder="Escribe la clave de seguridad">
          <button class="password-toggle" type="button" onclick="togglePasswordVisibility('setup-reinstall-password', this)" aria-label="Mostrar clave">👁</button>
        </div>
      </div>
      <div class="span-full" id="setup-reinstall-status" style="color:var(--text2);font-size:0.84rem"></div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="confirmSetupReinstallModal(${hasGoogleSession ? 'true' : 'false'})">Continuar</button>
  `;
  if (hasGoogleSession) pendingGoogleLinkSession = googleSession;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('setup-reinstall-password')?.focus(), 0);
}

async function confirmSetupReinstallModal(preserveGoogle = false) {
  const password = String(document.getElementById('setup-reinstall-password')?.value || '').trim();
  const status = document.getElementById('setup-reinstall-status');
  if (!password) {
    if (status) status.textContent = 'Debes ingresar la clave de seguridad.';
    return;
  }

  try {
    await api.verifySecurityPassword({ password });
    closeAllModals();
    if (preserveGoogle && pendingGoogleLinkSession?.idToken) {
      beginGoogleSetup(pendingGoogleLinkSession);
      setupWizard.forceReset = true;
      setupWizard.securityPassword = password;
      showToast('Asistente listo. Tu cuenta Google quedó vinculada al nuevo negocio.', 'success');
      return;
    }
    startSetupWizardSession({ preserveGoogle: false, forceReset: true, securityPassword: password });
    await refreshSetupPrinterOptions();
    showToast('Asistente de reinstalación listo. Ahora sí puedes crear el usuario nuevo.', 'success');
  } catch (error) {
    if (status) status.textContent = error.message || 'No se pudo validar la clave de seguridad.';
    if (typeof window.scheduleUiTranslation === 'function' && status) window.scheduleUiTranslation(status);
  }
}

function handleEnterActions(event) {
  if (event.key !== 'Enter' || event.defaultPrevented) return;

  const target = event.target;
  const tagName = target?.tagName || '';
  const isTextarea = tagName === 'TEXTAREA';
  const isButton = tagName === 'BUTTON';
  const modalOverlay = document.getElementById('modal-overlay');
  const loginScreen = document.getElementById('login-screen');
  const loginVisible = Boolean(loginScreen && !loginScreen.classList.contains('hidden') && loginScreen.style.display !== 'none');

  if (isTextarea || isButton) return;

  if (loginVisible && (target?.id === 'login-user' || target?.id === 'login-pass')) {
    event.preventDefault();
    doLogin();
    return;
  }

  if (!document.getElementById('app')?.classList.contains('hidden') && target?.id === 'monto-recibido') {
    event.preventDefault();
    if (typeof processSale === 'function') processSale();
    return;
  }

  if (modalOverlay && !modalOverlay.classList.contains('hidden')) {
    // El campo de código de producto recibe Enter del escáner como terminador — no disparar Guardar
    if (target?.id === 'mp-codigo') return;
    const actionButton = modalOverlay.querySelector('#modal-footer .btn-primary, #modal-footer .btn-danger');
    if (actionButton) {
      event.preventDefault();
      actionButton.click();
    }
  }
}

document.addEventListener('keydown', handleEnterActions);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateLoginUserPreview() {
  if (!DB.currentUser) return;
  document.querySelector('.user-name').textContent = DB.currentUser.nombre;
  document.querySelector('.user-role').textContent = DB.currentUser.rol;
  document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0];
}

function getLastLoginUser() {
  try {
    return String(localStorage.getItem(LAST_LOGIN_USER_KEY) || '').trim();
  } catch (_error) {
    return '';
  }
}

function setLastLoginUser(usuario) {
  const normalized = String(usuario || '').trim();
  try {
    if (normalized) {
      localStorage.setItem(LAST_LOGIN_USER_KEY, normalized);
    } else {
      localStorage.removeItem(LAST_LOGIN_USER_KEY);
    }
  } catch (_error) {
    // Keep the login flow usable even if localStorage is unavailable.
  }
}

function applyRememberedLoginUser() {
  const userInput = document.getElementById('login-user');
  const passInput = document.getElementById('login-pass');
  if (!userInput) return;
  const rememberedUser = getLastLoginUser();
  if (rememberedUser) {
    userInput.value = rememberedUser;
  }
  if (passInput) {
    passInput.value = '';
  }
}

function setLoginLoadingState(active, options = {}) {
  const card = document.querySelector('.login-card');
  const overlay = document.getElementById('login-loader-overlay');
  const title = document.getElementById('login-loader-title');
  const text = document.getElementById('login-loader-text');
  if (title && options.title) title.textContent = options.title;
  if (text && options.text) text.textContent = options.text;
  if (card) card.classList.toggle('is-loading', Boolean(active));
  if (overlay) {
    overlay.classList.toggle('hidden', !active);
    overlay.setAttribute('aria-hidden', active ? 'false' : 'true');
  }
  const controlIds = [
    'login-mode-existing',
    'login-mode-new',
    'login-language-select',
    'login-user',
    'login-pass',
    'login-submit-button',
    'login-google-button',
    'login-google-setup-button',
    'login-new-action',
    'login-reinstall-action'
  ];
  for (const id of controlIds) {
    const element = document.getElementById(id);
    if (element) element.disabled = Boolean(active);
  }
}

async function runLoginTransition(task, options = {}) {
  if (loginTransitionLock) return null;
  loginTransitionLock = true;
  setLoginLoadingState(true, {
    title: options.title || 'Preparando tu acceso',
    text: options.text || 'Validando tus datos y cargando la información inicial del negocio...'
  });
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (options.minDelay !== 0) {
      await sleep(typeof options.minDelay === 'number' ? options.minDelay : 520);
    }
    return await task();
  } finally {
    setLoginLoadingState(false);
    loginTransitionLock = false;
  }
}

async function activateAuthenticatedSession(response, sessionLanguage, options = {}) {
  hydrateDB(response.data);
  DB.config.idioma = sessionLanguage;
  setupWizard.language = sessionLanguage;
  DB.currentUser = response.user;
  DB.authToken = response.token || DB.authToken || null;
  if (typeof window.setTecnoCajaAuthToken === 'function') {
    window.setTecnoCajaAuthToken(DB.authToken || '');
  }
  setLastLoginUser(response?.user?.usuario || '');
  updateLoginUserPreview();
  if (typeof options.delayMs === 'number' && options.delayMs > 0) {
    await sleep(options.delayMs);
  }
  document.getElementById('setup-screen')?.classList.add('hidden');
  document.getElementById('login-screen')?.classList.add('hidden');
  const loginScreen = document.getElementById('login-screen');
  if (loginScreen) loginScreen.style.display = 'none';
  document.getElementById('app')?.classList.remove('hidden');
  initApp();
  const salesNav = document.querySelector('.nav-item[data-module="ventas"]');
  if (salesNav) {
    showModule('ventas', salesNav);
  }
}
  
async function doLogin() {
  if (loginTransitionLock) return;
  if (setupState?.setupRequired) {
    showToast(getUiText().loginHintSetupRequired, 'warning');
    setLoginMode('new');
    return;
  }
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const sessionLanguage = document.getElementById('login-language-select')?.value || setupWizard.language || DB.config?.idioma || 'es';
  try {
    await runLoginTransition(async () => {
      let response;
      try {
        response = await api.login(user, pass);
      } catch (mainErr) {
        // Si el error es de credenciales o licencia no intentar offline
        const rawErr = String(mainErr?.message || '').toLowerCase();
        const isCredError = rawErr.includes('contraseña') || rawErr.includes('licencia') ||
                            rawErr.includes('suspendida') || rawErr.includes('expiró') ||
                            rawErr.includes('clave de red');
        if (isCredError) throw mainErr;

        // Servidor principal no disponible — intentar login desde caché offline
        let offlineResp;
        try {
          offlineResp = await api.request('/api/auth/offline-login', {
            method: 'POST',
            body: JSON.stringify({ usuario: user, password: pass })
          });
        } catch (offlineErr) {
          // Offline login también falló — mostrar error más informativo
          const msg = String(offlineErr?.message || '');
          if (msg.includes('caché') || msg.includes('contraseña') || msg.includes('encontrado')) {
            throw offlineErr;
          }
          throw mainErr; // Propagar error original si el endpoint offline tampoco responde
        }

        // Cargar datos del caché local (productos, clientes, config)
        const bootstrap = await api.request('/api/offline/bootstrap').catch(() => ({}));
        response = {
          token: offlineResp.token,
          user: offlineResp.user,
          data: {
            productos: bootstrap.productos || [],
            clientes: bootstrap.clientes || [],
            users: bootstrap.users || [],
            sucursales: bootstrap.sucursales || [],
            cajasSucursal: bootstrap.cajasSucursal || [],
            config: bootstrap.config || {},
            metodosPago: bootstrap.metodosPago || [],
          }
        };
        setTimeout(() => showToast('Modo offline activo — las ventas se guardan localmente y se sincronizarán al restaurarse la conexión.', 'warning'), 600);
      }
      await activateAuthenticatedSession(response, sessionLanguage, { delayMs: 220 });
    }, {
      title: 'Iniciando tu sesión',
      text: 'Estamos validando el usuario, preparando la caja y sincronizando el negocio...'
    });
  } catch (error) {
    const rawMessage = String(error?.message || error || '').toLowerCase();
    if (rawMessage.includes('licencia') || rawMessage.includes('prueba del sistema expiró') || rawMessage.includes('suspendida')) {
      await refreshStartupStatus(false);
    }
    showToast(error.message || 'Usuario o contraseña incorrectos', 'error');
  }
}

async function doGoogleLogin() {
  if (loginTransitionLock) return;
  if (!window.firebaseWebAuth?.signInWithGoogle) {
    showToast('Google no está listo todavía en esta app.', 'error');
    return;
  }

  const sessionLanguage = document.getElementById('login-language-select')?.value || setupWizard.language || DB.config?.idioma || 'es';

  try {
    await runLoginTransition(async () => {
      const googleSession = await window.firebaseWebAuth.signInWithGoogle(sessionLanguage);
      pendingGoogleLinkSession = googleSession;
      if (setupState?.setupRequired) {
        beginGoogleSetup(googleSession);
        showToast(`Cuenta Google lista: ${googleSession.email || googleSession.name || 'Usuario nuevo'}`, 'success');
        return;
      }
      if (loginMode === 'new') {
        launchSetupWizardFromLogin({ googleSession });
        return;
      }
      const response = await api.loginWithGoogle(googleSession.idToken);
      await activateAuthenticatedSession(response, sessionLanguage, { delayMs: 220 });
      pendingGoogleLinkSession = null;
      showToast(`Sesión iniciada con Google: ${googleSession.email || DB.currentUser.email || DB.currentUser.nombre}`, 'success');
    }, {
      title: loginMode === 'new' ? 'Preparando tu cuenta' : 'Conectando con Google',
      text: loginMode === 'new'
        ? 'Estamos validando tu cuenta Google para comenzar la configuración del negocio...'
        : 'Validando tu cuenta Google y cargando los datos del sistema...'
    });
  } catch (error) {
    const raw = String(error?.message || error || '').trim();
    if (raw.includes('auth/popup-closed-by-user')) {
      showToast('Se cerró la ventana de Google antes de completar el acceso.', 'warning');
      return;
    }
    if (raw.includes('auth/popup-blocked')) {
      showToast('El navegador bloqueó la ventana emergente de Google.', 'error');
      return;
    }
    if (raw.includes('auth/unauthorized-domain')) {
      showToast('Debes autorizar este dominio en Firebase Auth antes de usar Google.', 'error');
      return;
    }
    if (raw.toLowerCase().includes('licencia') || raw.toLowerCase().includes('expiró') || raw.toLowerCase().includes('suspendida')) {
      await refreshStartupStatus(false);
    }
    if (raw.includes('no está vinculada a un Administrador o Supervisor activo del POS')) {
      openGoogleLinkModal();
      return;
    }
    showToast(error.message || 'No se pudo iniciar sesión con Google.', 'error');
  }
}

async function doLogout() {
  const exitStatus = canExitApp();
  if (!exitStatus.allowed) {
    showToast(exitStatus.reason, 'error');
    showModule('caja', document.querySelector('.nav-item[data-module="caja"]'));
    return;
  }
  stopLicenseWatcher();
  if (DB.currentUser?.authProvider === 'google' && window.firebaseWebAuth?.signOut) {
    try {
      await window.firebaseWebAuth.signOut();
    } catch (_error) {
      // Keep logout resilient even if Firebase logout fails.
    }
  }
  showLoginScreen();
  clearTrialBusinessRuntimeState();
  DB.currentUser = null;
  DB.authToken = null;
  if (typeof window.clearTecnoCajaAuthToken === 'function') {
    window.clearTecnoCajaAuthToken();
  }
  DB.saleItems = [];
  notificationsSeenCount = 0;
  updateLicenseUI();
}

async function reloadBootstrapData() {
  const currentUser = DB.currentUser;
  const authToken = DB.authToken;
  const sessionLanguage = setupWizard.language || DB.config?.idioma || 'es';
  const payload = await api.getBootstrap();
  hydrateDB(payload);
  DB.config.idioma = sessionLanguage;
  setupWizard.language = sessionLanguage;
  DB.currentUser = currentUser;
  DB.authToken = authToken;
  if (DB.currentUser) {
    document.querySelector('.user-name').textContent = DB.currentUser.nombre;
    document.querySelector('.user-role').textContent = DB.currentUser.rol;
    document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0];
  }
  initApp();
}

function initApp() {
  licenseBlockInProgress = false;
  restoreActiveTrialBusinessPreview();
  updateClock();
  if (!clockTimer) clockTimer = setInterval(updateClock, 1000);
  syncConfigForm();
  initConfigAccordions();
  updateStaticUiTexts();
  applyBranding();
  applyBusinessProfile();
  syncCajaState();
  applyRolePermissions();
  if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
  loadProductsTable();
  loadInventoryTable();
  loadClientesTable();
  if (typeof loadProveedoresTable === 'function') loadProveedoresTable();
  loadVentasHistory();
  loadUsuariosTable();
  if (typeof refreshMobilePosModule === 'function') refreshMobilePosModule();
  refreshOperationalData();
  updateInventoryStats();
  updateReportes();
  if (typeof updateProveedoresStats === 'function') updateProveedoresStats();
  refreshAuditLogs();
  updateNotifications();
  if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
  if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
  // Limpiar filtros del catálogo de ventas para la carga inicial
  const _initStockFilter = document.getElementById('sales-stock-filter');
  if (_initStockFilter) _initStockFilter.value = 'todos';
  const _initCategoryFilter = document.getElementById('sales-category-filter');
  if (_initCategoryFilter) _initCategoryFilter.value = '';
  const _initProductSearch = document.getElementById('product-search');
  if (_initProductSearch) _initProductSearch.value = '';
  if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
  updateLicenseUI();
  startLicenseWatcher();
  syncCashStartupGate();
  syncTrialBusinessPill();
  ensureTrialBusinessCatalog();
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
  document.getElementById('product-search').focus();

  // Iniciar el gestor de conexión offline (multicaja)
  if (window.OfflineManager && !window.offlineManager) {
    window.offlineManager = new OfflineManager({ healthCheckInterval: 5000 });
    window.offlineManager.initialize();
    // Poblar caché local con productos/clientes/usuarios (fire and forget)
    fetch('/api/offline/init-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getStoredAuthToken ? getStoredAuthToken() : ''}` }
    }).catch(() => {});
  } else if (window.offlineManager) {
    // Re-sincronizar caché si ya existe una sesión activa
    fetch('/api/offline/init-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getStoredAuthToken ? getStoredAuthToken() : ''}` }
    }).catch(() => {});
  }
}

function updateClock() {
  const el = document.getElementById('topbar-time');
  if (el) el.textContent = new Date().toLocaleString(getCurrentLocale(), {weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function showModule(name, el) {
  if (!isBusinessModuleEnabled(name)) {
    showToast('Este módulo no está activo para el tipo de negocio seleccionado.', 'warning');
    return;
  }
  if (!canAccessModule(name)) {
    showToast('No tienes permiso para entrar a este módulo', 'error');
    return;
  }
  document.querySelectorAll('.module').forEach(m => {
    m.classList.remove('active');
    m.classList.add('hidden');
    m.style.display = 'none';
  });
  const mod = document.getElementById('module-' + name);
  if (mod) {
    mod.classList.remove('hidden');
    mod.style.display = 'flex';
    mod.classList.add('active');
  }
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('breadcrumb').textContent = el ? el.querySelector('.nav-label').textContent : name;
  if (name === 'ventas') document.getElementById('product-search').focus();
  if (name === 'productos') {
    if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
    if (typeof loadProductsTable === 'function') loadProductsTable();
  }
  if (name === 'movimientos') {
    if (typeof syncMovimientosModuleFilter === 'function') syncMovimientosModuleFilter();
    if (typeof renderMovimientosSistema === 'function') renderMovimientosSistema();
  }
  if (name === 'ventas') {
    // Limpiar búsqueda y resetear filtro de stock al entrar al módulo,
    // para evitar que valores persistidos por el navegador dejen el catálogo vacío.
    const _catalogStockFilter = document.getElementById('sales-stock-filter');
    if (_catalogStockFilter && _catalogStockFilter.value !== 'todos') _catalogStockFilter.value = 'todos';
    const _catalogCategoryFilter = document.getElementById('sales-category-filter');
    if (_catalogCategoryFilter) _catalogCategoryFilter.value = '';
    if (typeof refreshSaleClientOptions === 'function') refreshSaleClientOptions();
    if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
    if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
    // Re-render diferido por si el DOM todavía está acomodándose en la carga inicial
    setTimeout(() => { if (typeof renderSalesCatalog === 'function') renderSalesCatalog(); }, 250);
  }
  if (name === 'proveedores') {
    if (typeof loadProveedoresTable === 'function') loadProveedoresTable();
    if (typeof updateProveedoresStats === 'function') updateProveedoresStats();
  }
  if (name === 'posmovil') {
    if (typeof refreshMobilePosModule === 'function') refreshMobilePosModule();
  }
  if (name === 'reportes') { loadVentasHistory(); updateReportes(); }
  if (name === 'inventario') { updateInventoryStats(); loadInventoryTable(); }
  if (name === 'caja') { refreshCajaFromServer(); }
  if (name === 'colacobro') { loadColaCobro(); }
  if (name === 'delivery') { if (typeof initDeliveryPanel === 'function') initDeliveryPanel(); }
  if (name !== 'delivery') { if (typeof stopDeliveryPanel === 'function') stopDeliveryPanel(); }
  if (name === 'archivos') { if (typeof FileManager !== 'undefined') FileManager.init(); }
  if (name === 'configuracion') {
    if (typeof loadNcfSequences === 'function') loadNcfSequences();
    if (typeof loadBasculaConfig === 'function') loadBasculaConfig();
    // Inicializar módulo de actualización del sistema
    if (typeof window.Actualizaciones?.init === 'function') window.Actualizaciones.init();
  }
  closeNotifications();
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (window.innerWidth <= 800) {
    sidebar.classList.toggle('open');
    return;
  }
  sidebar.classList.toggle('collapsed');
}

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function setTheme(val) {
  const theme = val === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  const button = document.getElementById('topbar-theme-toggle');
  if (button) button.textContent = theme === 'dark' ? '🌙' : '☀️';
  const select = document.getElementById('cfg-theme');
  if (select) select.value = theme;
  saveUiPreferences();
}

function setAccent(color, light) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-light', light);
  // rebuild glow
  const rgb = hexToRgb(color);
  if (rgb) document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb.r},${rgb.g},${rgb.b},0.25)`);
  saveUiPreferences();
}

function initConfigAccordions(rootSelector = '#module-configuracion') {
  const root = document.querySelector(rootSelector);
  if (!root) return;
  const sections = root.querySelectorAll('.config-section');
  if (!sections.length) return;
  const isConfigRoot = rootSelector === '#module-configuracion';

  sections.forEach((section, index) => {
    if (section.dataset.accordionReady === 'true') return;

    const heading = section.querySelector('h3');
    if (!heading) return;

    const body = document.createElement('div');
    body.className = 'config-section-body';

    while (heading.nextSibling) {
      body.appendChild(heading.nextSibling);
    }

    section.appendChild(body);
    section.dataset.accordionReady = 'true';
    const shouldCollapse = isConfigRoot
      ? String(section.dataset.collapsed) !== 'false'
      : (String(section.dataset.collapsed) === 'true' || (rootSelector === '#module-posmovil' && index > 0));
    section.classList.toggle('collapsed', shouldCollapse);

    heading.addEventListener('click', () => {
      const willOpen = section.classList.contains('collapsed');
      if (isConfigRoot) {
        sections.forEach((item) => item.classList.add('collapsed'));
        if (willOpen) {
          section.classList.remove('collapsed');
        }
        return;
      }
      section.classList.toggle('collapsed');
    });
  });
}

function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? {r:parseInt(r[1],16),g:parseInt(r[2],16),b:parseInt(r[3],16)} : null;
}

function getUiPreferences() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function saveUiPreferences() {
  try {
    const currentPrefs = getUiPreferences();
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
      ...currentPrefs,
      theme: document.documentElement.getAttribute('data-theme') || 'dark',
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6C63FF',
      accentLight: getComputedStyle(document.documentElement).getPropertyValue('--accent-light').trim() || '#8B85FF'
    }));
  } catch (_error) {
    // Keep the UI usable even if localStorage is unavailable.
  }
}

function applyUiPreferences() {
  const prefs = getUiPreferences();
  if (prefs.accent && prefs.accentLight) {
    document.documentElement.style.setProperty('--accent', prefs.accent);
    document.documentElement.style.setProperty('--accent-light', prefs.accentLight);
    const rgb = hexToRgb(prefs.accent);
    if (rgb) {
      document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb.r},${rgb.g},${rgb.b},0.25)`);
    }
  }
  setTheme(prefs.theme || document.documentElement.getAttribute('data-theme') || 'dark');
}

function saveConfig() {
  const taxInput = document.getElementById('cfg-itbis').value.trim();
  const parsedTax = taxInput === '' ? 0 : Number(taxInput);
  const previousLanguage = DB.config?.idioma || 'es';
  const nextConfig = {
    ...DB.config,
    ...getConfigPreviewValues(parsedTax)
  };

  api.saveConfig({ ...nextConfig, ...getActorPayload() })
    .then((config) => {
      DB.config = { ...DB.config, ...config };
      setupWizard.language = DB.config?.idioma || setupWizard.language || 'es';
      const languageChanged = previousLanguage !== (DB.config?.idioma || 'es');
      renderStartupLanguageOptions();
      updateStaticUiTexts();
      applyBusinessProfile();
      syncConfigForm();
      applyBranding();
      if (typeof refreshProductCategoryFilter === 'function') refreshProductCategoryFilter();
      if (typeof refreshInventoryCategoryFilter === 'function') refreshInventoryCategoryFilter();
      if (typeof loadProductsTable === 'function') loadProductsTable();
      if (typeof loadInventoryTable === 'function') loadInventoryTable();
      if (typeof renderSaleTable === 'function') renderSaleTable();
      if (typeof renderSalesCatalog === 'function') renderSalesCatalog();
      if (typeof updateTotals === 'function') updateTotals();
      if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
      if (typeof updateReportes === 'function') updateReportes();
      if (isTrialBusinessModeActive()) {
        restoreActiveTrialBusinessPreview();
        refreshBusinessModeUi();
      }
      refreshAuditLogs();
      translateDynamicUi(document.body);
      lockBusinessStructureMode();
      _updatePlanBadge();
      showToast('Configuración guardada correctamente', 'success');
      if (languageChanged) {
        setTimeout(() => window.location.reload(), 150);
      }
    })
    .catch((error) => showToast(error.message, 'error'));
}

function getConfigPreviewValues(parsedTaxOverride = null) {
  const taxInput = document.getElementById('cfg-itbis')?.value?.trim() || '';
  const parsedTax = parsedTaxOverride === null
    ? (taxInput === '' ? 0 : Number(taxInput))
    : parsedTaxOverride;
  const eInvoiceCheckbox = document.getElementById('cfg-einvoice-enabled');
  const taxCalculateAtEndCheckbox = document.getElementById('cfg-tax-calculate-at-end');
  const taxIncludeInPriceCheckbox = document.getElementById('cfg-tax-include-in-price');
  const taxShowBreakdownCheckbox = document.getElementById('cfg-tax-show-breakdown');
  const taxSeparateSubtotalsCheckbox = document.getElementById('cfg-tax-separate-subtotals');

  return {
    nombre: document.getElementById('cfg-nombre')?.value || DB.config?.nombre || '',
    logo: document.getElementById('cfg-logo-input')?.dataset.logoData || DB.config?.logo || '',
    rnc: document.getElementById('cfg-rnc')?.value || DB.config?.rnc || '',
    direccion: document.getElementById('cfg-dir')?.value || DB.config?.direccion || '',
    telefono: document.getElementById('cfg-tel')?.value || DB.config?.telefono || '',
    businessStructureMode: normalizeBusinessStructureMode(document.getElementById('cfg-business-structure-mode')?.value || DB.config?.businessStructureMode),
    idioma: document.getElementById('cfg-language')?.value || DB.config?.idioma || 'es',
    moneda: document.getElementById('cfg-moneda')?.value || DB.config?.moneda || 'RD$',
    itbis: Number.isFinite(parsedTax) ? Math.max(0, parsedTax) : 0,
    taxCalculateAtInvoiceEnd: taxCalculateAtEndCheckbox
      ? Boolean(taxCalculateAtEndCheckbox.checked)
      : Boolean(DB.config?.taxCalculateAtInvoiceEnd ?? true),
    taxIncludeInProductPrice: taxIncludeInPriceCheckbox
      ? Boolean(taxIncludeInPriceCheckbox.checked)
      : Boolean(DB.config?.taxIncludeInProductPrice ?? false),
    taxShowBreakdownOnReceipts: taxShowBreakdownCheckbox
      ? Boolean(taxShowBreakdownCheckbox.checked)
      : Boolean(DB.config?.taxShowBreakdownOnReceipts ?? true),
    taxSeparateTaxableAndExempt: taxSeparateSubtotalsCheckbox
      ? Boolean(taxSeparateSubtotalsCheckbox.checked)
      : Boolean(DB.config?.taxSeparateTaxableAndExempt ?? true),
    prefix: document.getElementById('cfg-prefix')?.value || DB.config?.prefix || 'FAC-',
    nextInvoice: Math.max(1, parseInt(document.getElementById('cfg-next-invoice')?.value, 10) || 1),
    eInvoiceEnabled: eInvoiceCheckbox
      ? Boolean(eInvoiceCheckbox.checked)
      : Boolean(DB.config?.eInvoiceEnabled ?? true),
    eInvoicePrefix: document.getElementById('cfg-e-prefix')?.value || DB.config?.eInvoicePrefix || 'ECF-',
    eInvoiceNextNumber: Math.max(1, parseInt(document.getElementById('cfg-next-einvoice')?.value, 10) || 1),
    mensaje: document.getElementById('cfg-msg')?.value || DB.config?.mensaje || '',
    receiptPrintMode: document.getElementById('cfg-print-mode')?.value || DB.config?.receiptPrintMode || 'dialog',
    receiptPrinterName: document.getElementById('cfg-printer-name')?.value || DB.config?.receiptPrinterName || '',
    receiptPaperSize: document.getElementById('cfg-paper-size')?.value || DB.config?.receiptPaperSize || '80mm',
    cashierRegisterRequired: Boolean(document.getElementById('cfg-cashier-register-required')?.checked ?? DB.config?.cashierRegisterRequired ?? true),
    exclusiveCashierPerRegister: Boolean(document.getElementById('cfg-exclusive-cashier-register')?.checked ?? DB.config?.exclusiveCashierPerRegister ?? true),
    whatsappWebEnabled: Boolean(document.getElementById('cfg-whatsapp-web-enabled')?.checked),
    whatsappPasteGuideEnabled: Boolean(document.getElementById('cfg-whatsapp-guide-enabled')?.checked ?? DB.config?.whatsappPasteGuideEnabled ?? true),
    salesSplitViewEnabled: Boolean(document.getElementById('cfg-sales-split-view-enabled')?.checked ?? DB.config?.salesSplitViewEnabled ?? false),
    // ── Gaveta registradora ──
    cashDrawerEnabled: Boolean(document.getElementById('cfg-drawer-enabled')?.checked ?? DB.config?.cashDrawerEnabled ?? false),
    cashDrawerMethod: document.getElementById('cfg-drawer-method')?.value || DB.config?.cashDrawerMethod || 'escpos',
    cashDrawerPrinterName: document.getElementById('cfg-drawer-printer')?.value || DB.config?.cashDrawerPrinterName || '',
    cashDrawerPin: Number(document.getElementById('cfg-drawer-pin')?.value ?? DB.config?.cashDrawerPin ?? 0),
    cashDrawerNetworkHost: document.getElementById('cfg-drawer-network-host')?.value || DB.config?.cashDrawerNetworkHost || '',
    cashDrawerNetworkPort: Number(document.getElementById('cfg-drawer-network-port')?.value || DB.config?.cashDrawerNetworkPort || 9100),
    cashDrawerSerialPort: document.getElementById('cfg-drawer-serial-port')?.value || DB.config?.cashDrawerSerialPort || 'COM1',
    scaleType: document.getElementById('cfg-scale-type')?.value || DB.config?.scaleType || 'none',
    scaleSerialPort: document.getElementById('cfg-scale-serial-port')?.value || DB.config?.scaleSerialPort || '',
    scaleSerialBaudRate: Number(document.getElementById('cfg-scale-serial-baud-rate')?.value || DB.config?.scaleSerialBaudRate || 9600),
    scaleDefaultUnit: document.getElementById('cfg-scale-default-unit')?.value || DB.config?.scaleDefaultUnit || 'kg',
    scaleReadPattern: document.getElementById('cfg-scale-read-pattern')?.value || DB.config?.scaleReadPattern || '',
    scaleRoundingDecimals: Number(document.getElementById('cfg-scale-rounding-decimals')?.value ?? DB.config?.scaleRoundingDecimals ?? 2),
    scaleAutoRead: Boolean(document.getElementById('cfg-scale-auto-read')?.checked ?? DB.config?.scaleAutoRead ?? true),
  };
}

function syncTaxConfigToggles(changedId = '') {
  const calculateAtEnd = document.getElementById('cfg-tax-calculate-at-end');
  const includeInPrice = document.getElementById('cfg-tax-include-in-price');
  if (!calculateAtEnd || !includeInPrice) return;

  if (changedId === 'cfg-tax-calculate-at-end' && calculateAtEnd.checked) {
    includeInPrice.checked = false;
  } else if (changedId === 'cfg-tax-include-in-price' && includeInPrice.checked) {
    calculateAtEnd.checked = false;
  }

  if (!calculateAtEnd.checked && !includeInPrice.checked) {
    calculateAtEnd.checked = true;
  }
}

function syncConfigForm() {
  const cfg = DB.config;
  const languageSelect = document.getElementById('cfg-language');
  if (languageSelect) {
    languageSelect.innerHTML = getAvailableLanguages().map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
    languageSelect.value = cfg.idioma || 'es';
  }
  const activeElement = document.activeElement;
  const fields = {
    'cfg-nombre': cfg.nombre,
    'cfg-rnc': cfg.rnc,
    'cfg-dir': cfg.direccion,
    'cfg-tel': cfg.telefono,
    'cfg-itbis': cfg.itbis,
    'cfg-prefix': cfg.prefix,
    'cfg-next-invoice': cfg.nextInvoice,
    'cfg-e-prefix': cfg.eInvoicePrefix,
    'cfg-next-einvoice': cfg.eInvoiceNextNumber,
    'cfg-msg': cfg.mensaje,
    'cfg-print-mode': cfg.receiptPrintMode || 'dialog',
    'cfg-paper-size': cfg.receiptPaperSize || '80mm'
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el === activeElement) return;
    el.value = val ?? '';
  });
  const moneda = document.getElementById('cfg-moneda');
  if (moneda && moneda !== activeElement) {
    moneda.value = cfg.moneda || 'RD$';
  }
  const taxCalculateAtEndToggle = document.getElementById('cfg-tax-calculate-at-end');
  if (taxCalculateAtEndToggle) {
    taxCalculateAtEndToggle.checked = Boolean(cfg.taxCalculateAtInvoiceEnd ?? true);
  }
  const taxIncludeInPriceToggle = document.getElementById('cfg-tax-include-in-price');
  if (taxIncludeInPriceToggle) {
    taxIncludeInPriceToggle.checked = Boolean(cfg.taxIncludeInProductPrice ?? false);
  }
  const taxShowBreakdownToggle = document.getElementById('cfg-tax-show-breakdown');
  if (taxShowBreakdownToggle) {
    taxShowBreakdownToggle.checked = Boolean(cfg.taxShowBreakdownOnReceipts ?? true);
  }
  const taxSeparateSubtotalsToggle = document.getElementById('cfg-tax-separate-subtotals');
  if (taxSeparateSubtotalsToggle) {
    taxSeparateSubtotalsToggle.checked = Boolean(cfg.taxSeparateTaxableAndExempt ?? true);
  }
  syncTaxConfigToggles();
  const businessTypeReadonly = document.getElementById('cfg-business-type-readonly');
  if (businessTypeReadonly) businessTypeReadonly.value = cfg.businessProfile?.label || cfg.tipoNegocio || 'Sin definir';
  const businessStructureSelect = document.getElementById('cfg-business-structure-mode');
  if (businessStructureSelect) {
    businessStructureSelect.innerHTML = getBusinessStructureOptionsForUi().map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
    if (businessStructureSelect !== activeElement) {
      businessStructureSelect.value = normalizeBusinessStructureMode(cfg.businessStructureMode);
    }
  }
  applyBusinessStructureDraftState(cfg.businessStructureMode);
  lockBusinessStructureMode();
  const licenseReadonly = document.getElementById('cfg-license-readonly');
  if (licenseReadonly) {
    licenseReadonly.value = cfg.licenseStatus === 'active'
      ? appText('license.active', 'Licencia activa')
      : (cfg.licenseStatus === 'suspended'
          ? appText('license.suspended', 'Licencia suspendida')
          : (cfg.trialExpired
              ? appText('license.expired', 'Prueba vencida')
              : fillText(appText('license.trialShort', 'Prueba: {days} día(s)'), { days: Number(cfg.trialDaysLeft || 0) })));
  }
  const eInvoiceEnabled = document.getElementById('cfg-einvoice-enabled');
  if (eInvoiceEnabled && eInvoiceEnabled !== activeElement) eInvoiceEnabled.checked = Boolean(cfg.eInvoiceEnabled);
  const printerSelect = document.getElementById('cfg-printer-name');
  if (printerSelect) {
    printerSelect.dataset.selectedPrinter = cfg.receiptPrinterName || '';
  }
  const themeSelect = document.getElementById('cfg-theme');
  if (themeSelect && themeSelect !== activeElement) {
    themeSelect.value = document.documentElement.getAttribute('data-theme') || 'dark';
  }
  const whatsappToggle = document.getElementById('cfg-whatsapp-web-enabled');
  if (whatsappToggle && whatsappToggle !== activeElement) {
    whatsappToggle.checked = Boolean(cfg.whatsappWebEnabled);
  }
  const whatsappGuideToggle = document.getElementById('cfg-whatsapp-guide-enabled');
  if (whatsappGuideToggle && whatsappGuideToggle !== activeElement) {
    whatsappGuideToggle.checked = Boolean(cfg.whatsappPasteGuideEnabled ?? true);
  }
  const salesSplitViewToggle = document.getElementById('cfg-sales-split-view-enabled');
  if (salesSplitViewToggle && salesSplitViewToggle !== activeElement) {
    salesSplitViewToggle.checked = Boolean(cfg.salesSplitViewEnabled);
  }
  if (typeof syncSalesSplitViewLayout === 'function') {
    syncSalesSplitViewLayout(Boolean(cfg.salesSplitViewEnabled));
  }
  const cashierRegisterToggle = document.getElementById('cfg-cashier-register-required');
  if (cashierRegisterToggle && cashierRegisterToggle !== activeElement) {
    cashierRegisterToggle.checked = Boolean(cfg.cashierRegisterRequired ?? true);
  }
  const exclusiveCashierToggle = document.getElementById('cfg-exclusive-cashier-register');
  if (exclusiveCashierToggle && exclusiveCashierToggle !== activeElement) {
    exclusiveCashierToggle.checked = Boolean(cfg.exclusiveCashierPerRegister ?? true);
  }
  // ── Gaveta registradora ──
  const drawerEnabledToggle = document.getElementById('cfg-drawer-enabled');
  if (drawerEnabledToggle && drawerEnabledToggle !== activeElement) {
    drawerEnabledToggle.checked = Boolean(cfg.cashDrawerEnabled);
    const drawerFields = document.getElementById('cfg-drawer-fields');
    if (drawerFields) drawerFields.style.display = cfg.cashDrawerEnabled ? '' : 'none';
  }
  drawerEnabledToggle?.addEventListener('change', function () {
    const drawerFields = document.getElementById('cfg-drawer-fields');
    if (drawerFields) drawerFields.style.display = this.checked ? '' : 'none';
  }, { once: true });
  const drawerMethodSel = document.getElementById('cfg-drawer-method');
  if (drawerMethodSel && drawerMethodSel !== activeElement) {
    drawerMethodSel.value = cfg.cashDrawerMethod || 'escpos';
    syncDrawerMethodFields();
  }
  const drawerPinSel = document.getElementById('cfg-drawer-pin');
  if (drawerPinSel && drawerPinSel !== activeElement) drawerPinSel.value = String(cfg.cashDrawerPin ?? 0);
  const drawerPrinterSelect = document.getElementById('cfg-drawer-printer');
  if (drawerPrinterSelect) {
    drawerPrinterSelect.dataset.selectedPrinter = cfg.cashDrawerPrinterName || '';
  }
  const drawerNetHost = document.getElementById('cfg-drawer-network-host');
  if (drawerNetHost && drawerNetHost !== activeElement) drawerNetHost.value = cfg.cashDrawerNetworkHost || '';
  const drawerNetPort = document.getElementById('cfg-drawer-network-port');
  if (drawerNetPort && drawerNetPort !== activeElement) drawerNetPort.value = cfg.cashDrawerNetworkPort || 9100;
  const drawerSerial = document.getElementById('cfg-drawer-serial-port');
  if (drawerSerial && drawerSerial !== activeElement) drawerSerial.value = cfg.cashDrawerSerialPort || 'COM1';
  const scaleType = document.getElementById('cfg-scale-type');
  if (scaleType && scaleType !== activeElement) {
    scaleType.value = cfg.scaleType || 'none';
  }
  const scaleAutoRead = document.getElementById('cfg-scale-auto-read');
  if (scaleAutoRead && scaleAutoRead !== activeElement) {
    scaleAutoRead.checked = Boolean(cfg.scaleAutoRead ?? true);
  }
  const scaleBaud = document.getElementById('cfg-scale-serial-baud-rate');
  if (scaleBaud && scaleBaud !== activeElement) {
    scaleBaud.value = cfg.scaleSerialBaudRate || 9600;
  }
  const scaleDefaultUnit = document.getElementById('cfg-scale-default-unit');
  if (scaleDefaultUnit && scaleDefaultUnit !== activeElement) {
    scaleDefaultUnit.value = cfg.scaleDefaultUnit || 'kg';
  }
  const scalePattern = document.getElementById('cfg-scale-read-pattern');
  if (scalePattern && scalePattern !== activeElement) {
    scalePattern.value = cfg.scaleReadPattern || '';
  }
  const scaleDecimals = document.getElementById('cfg-scale-rounding-decimals');
  if (scaleDecimals && scaleDecimals !== activeElement) {
    scaleDecimals.value = Number(cfg.scaleRoundingDecimals ?? 2);
  }
  const scaleSerialPort = document.getElementById('cfg-scale-serial-port');
  if (scaleSerialPort) {
    scaleSerialPort.dataset.selectedPort = cfg.scaleSerialPort || '';
  }
  syncScaleMethodFields();

  syncWhatsAppButtons(cfg.whatsappWebEnabled);
  const accessUser = document.getElementById('cfg-access-user');
  if (accessUser) accessUser.value = DB.currentUser?.usuario || '';
  const accessMethods = document.getElementById('cfg-access-methods');
  if (accessMethods) accessMethods.value = getAccessMethodsLabel();
  const accessPasswordText = document.getElementById('cfg-access-password-text');
  if (accessPasswordText) {
    accessPasswordText.textContent = DB.currentUser?.googleLinked
      ? appText('settings.accessPasswordTextGoogle', 'Tu cuenta ya puede entrar con Google. Desde aquí puedes crear o cambiar una contraseña para entrar también con usuario y contraseña.')
      : appText('settings.accessPasswordTextLocal', 'Desde aquí puedes crear o cambiar la contraseña local para entrar con tu usuario.');
  }
  const accessPasswordBtn = document.getElementById('cfg-btn-change-access-password');
  if (accessPasswordBtn) {
    accessPasswordBtn.textContent = DB.currentUser?.localPasswordSet
      ? `🔑 ${appText('settings.accessPasswordButtonChange', 'Cambiar contraseña')}`
      : `🔑 ${appText('settings.accessPasswordButtonCreate', 'Crear contraseña')}`;
  }
  const saleTaxLabel = document.getElementById('sale-tax-label');
  if (saleTaxLabel) {
    saleTaxLabel.textContent = `ITBIS (${Number(cfg.itbis || 0)}%)`;
  }
  const logoInput = document.getElementById('cfg-logo-input');
  if (logoInput) logoInput.dataset.logoData = cfg.logo || '';
  updateLogoPreview(cfg.logo || '');
  syncBusinessStructureControls();
  renderAdminDeleteLists();
  syncTrialBusinessConfigPanel();
  syncTrialBusinessPill();
  refreshPrinterOptions();
  refreshDrawerPrinterOptions();
  refreshScaleSerialPorts();
  renderPlanSection();
}

function syncBusinessStructureControls() {
  const branchSelect = document.getElementById('cfg-active-branch');
  const registerSelect = document.getElementById('cfg-active-cash-register');
  const activeBranchId = Number(DB.config?.activeBranchId || 0);
  const activeCashRegisterId = Number(DB.config?.activeCashRegisterId || 0);

  if (branchSelect) {
    branchSelect.innerHTML = (DB.sucursales || []).map((branch) => `<option value="${branch.id}">${branch.nombre}${branch.codigo ? ` · ${branch.codigo}` : ''}</option>`).join('');
    if (activeBranchId && (DB.sucursales || []).some((branch) => Number(branch.id) === activeBranchId)) {
      branchSelect.value = String(activeBranchId);
    }
  }

  if (registerSelect) {
    const branchId = Number(branchSelect?.value || activeBranchId || 0);
    const registers = getCashRegistersForBranch(branchId);
    registerSelect.innerHTML = registers.map((item) => `<option value="${item.id}">${item.nombre}${item.codigo ? ` · ${item.codigo}` : ''}</option>`).join('');
    const preferredRegisterId = registers.some((item) => Number(item.id) === activeCashRegisterId)
      ? activeCashRegisterId
      : Number(registers[0]?.id || 0);
    if (preferredRegisterId) {
      registerSelect.value = String(preferredRegisterId);
    }
  }

  const identity = document.getElementById('caja-identity');
  if (identity) {
    const branch = getActiveBranch();
    const cashRegister = getActiveCashRegister();
    identity.textContent = `${branch?.nombre || 'Sin sucursal'} · ${cashRegister?.nombre || 'Sin caja'}`;
  }
  applyBusinessStructureDraftState(DB.config?.businessStructureMode);
}

function applyBusinessStructureDraftState(modeValue = null) {
  const normalizedMode = normalizeBusinessStructureMode(modeValue || document.getElementById('cfg-business-structure-mode')?.value || DB.config?.businessStructureMode);
  const branchHelper = document.getElementById('cfg-branch-helper');
  if (branchHelper) {
    branchHelper.textContent = normalizedMode === 'multisucursal'
      ? appText('settings.branchHelperBranches', 'Modo multisucursal activo. Puedes crear sucursales y cajas según tu operación.')
      : (normalizedMode === 'multicaja'
          ? appText('settings.branchHelperMulti', 'Modo multicaja activo. Puedes crear varias cajas, pero todas pertenecerán a la misma sucursal.')
          : appText('settings.branchHelperSingle', 'Modo monocaja activo. Trabajarás con la sucursal principal y su única caja.'));
  }

  const businessStructureHelper = document.getElementById('cfg-business-structure-helper');
  if (businessStructureHelper) {
    businessStructureHelper.textContent = normalizedMode === 'multisucursal'
      ? appText('settings.businessStructureHelperBranches', 'Multisucursal habilita varias sucursales y sus cajas dentro del mismo sistema.')
      : (normalizedMode === 'multicaja'
          ? appText('settings.businessStructureHelperMulti', 'Multicaja usa una sola sucursal con varias cajas sobre la misma base de datos.')
          : appText('settings.businessStructureHelperSingle', 'Monocaja usa una sola sucursal con una sola caja para mantener la operación simple.'));
  }

  const allowsBranches = normalizedMode === 'multisucursal';
  const allowsRegisters = normalizedMode === 'multicaja' || normalizedMode === 'multisucursal';
  const newBranchGroup = document.getElementById('cfg-new-branch-group');
  const newBranchLocked = document.getElementById('cfg-new-branch-locked');
  const newCashGroup = document.getElementById('cfg-new-cash-register-group');
  const newCashLocked = document.getElementById('cfg-new-cash-register-locked');
  ['cfg-new-branch-name', 'cfg-new-branch-code', 'cfg-btn-create-branch'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = !allowsBranches;
  });
  ['cfg-new-cash-register-name', 'cfg-new-cash-register-code', 'cfg-btn-create-cash-register'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = !allowsRegisters;
  });

  if (newBranchGroup) newBranchGroup.classList.toggle('hidden', !allowsBranches);
  if (newCashGroup) newCashGroup.classList.toggle('hidden', !allowsRegisters);
  if (newBranchLocked) {
    newBranchLocked.classList.toggle('hidden', allowsBranches);
    if (!allowsBranches) {
      newBranchLocked.innerHTML = normalizedMode === 'multicaja'
        ? `<strong>${appText('settings.branchLockedTitleMulti', 'Nueva sucursal bloqueada por el modo actual')}</strong>${appText('settings.branchLockedTextMulti', 'Estás trabajando en Multicaja. En este modo solo existe una sucursal. Si necesitas crear sucursales nuevas, cambia primero el modo de operación a Multisucursal y luego guarda los cambios.')}`
        : `<strong>${appText('settings.branchLockedTitleSingle', 'Nueva sucursal no disponible en Monocaja')}</strong>${appText('settings.branchLockedTextSingle', 'Monocaja usa una única sucursal principal. Para habilitar más sucursales, cambia el modo de operación a Multisucursal y guarda la configuración.')}`;
    }
  }
  if (newCashLocked) {
    newCashLocked.classList.toggle('hidden', allowsRegisters);
    if (!allowsRegisters) {
      newCashLocked.innerHTML = `<strong>${appText('settings.cashLockedTitleSingle', 'Nueva caja no disponible en Monocaja')}</strong>${appText('settings.cashLockedTextSingle', 'Monocaja usa solo la caja principal. Si quieres crear más cajas, cambia el modo de operación a Multicaja o Multisucursal y guarda la configuración.')}`;
    }
  }

  const branchSelect = document.getElementById('cfg-active-branch');
  const registerSelect = document.getElementById('cfg-active-cash-register');
  if (branchSelect) branchSelect.disabled = normalizedMode === 'monocaja' || normalizedMode === 'multicaja';
  if (registerSelect) registerSelect.disabled = normalizedMode === 'monocaja';

  const tipoPanel = document.getElementById('cfg-cash-register-types-panel');
  if (tipoPanel) {
    const showTipoPanel = allowsRegisters;
    tipoPanel.style.display = showTipoPanel ? '' : 'none';
    if (showTipoPanel) renderCashRegisterTypesPanel();
  }

  syncUserProvisioningRulesDraftState(normalizedMode);
}

function syncUserProvisioningRulesDraftState(modeValue = null) {
  const normalizedMode = normalizeBusinessStructureMode(modeValue || document.getElementById('cfg-business-structure-mode')?.value || DB.config?.businessStructureMode);
  const cashierToggle = document.getElementById('cfg-cashier-register-required');
  const exclusiveToggle = document.getElementById('cfg-exclusive-cashier-register');
  const cashierHelper = document.getElementById('cfg-cashier-register-required-helper');
  const exclusiveHelper = document.getElementById('cfg-exclusive-cashier-register-helper');

  if (!cashierToggle || !exclusiveToggle) return;

  if (normalizedMode === 'monocaja') {
    cashierToggle.checked = true;
    exclusiveToggle.checked = true;
    cashierToggle.disabled = true;
    exclusiveToggle.disabled = true;
    if (cashierHelper) {
      cashierHelper.textContent = appText('settings.cashierRegisterRequiredHelperSingle', 'En monocaja la caja principal se asigna automáticamente, por eso esta regla queda fija.');
    }
    if (exclusiveHelper) {
      exclusiveHelper.textContent = appText('settings.exclusiveCashierRegisterHelperSingle', 'En monocaja la caja principal es única y la asignación queda controlada automáticamente.');
    }
    return;
  }

  cashierToggle.disabled = false;
  exclusiveToggle.disabled = false;

  if (normalizedMode === 'multicaja') {
    if (cashierHelper) {
      cashierHelper.textContent = appText('settings.cashierRegisterRequiredHelperMulti', 'En multicaja puedes decidir si el cajero debe quedar amarrado obligatoriamente a una caja de la sucursal principal.');
    }
    if (exclusiveHelper) {
      exclusiveHelper.textContent = appText('settings.exclusiveCashierRegisterHelperMulti', 'Impide repetir cajeros fijos sobre la misma caja dentro de la sucursal principal.');
    }
    return;
  }

  if (cashierHelper) {
    cashierHelper.textContent = appText('settings.cashierRegisterRequiredHelperBranches', 'En multisucursal define si el cajero debe quedar ligado a una caja después de elegir su sucursal.');
  }
  if (exclusiveHelper) {
    exclusiveHelper.textContent = appText('settings.exclusiveCashierRegisterHelperBranches', 'Impide repetir cajeros fijos en una misma caja, incluso cuando existan varias sucursales.');
  }
}

function handleBusinessStructureModeDraftChange() {
  applyBusinessStructureDraftState(document.getElementById('cfg-business-structure-mode')?.value);
}

window.handleBusinessStructureModeDraftChange = handleBusinessStructureModeDraftChange;

function lockBusinessStructureMode() {
  const select = document.getElementById('cfg-business-structure-mode');
  const btn = document.getElementById('btn-unlock-structure-mode');
  if (select) { select.disabled = true; select.style.opacity = '0.75'; select.style.cursor = 'not-allowed'; }
  if (btn) { btn.textContent = '🔒 Cambiar'; btn.disabled = false; }
}

function unlockBusinessStructureMode() {
  showSuperAdminPasswordModal(
    'Cambiar modo de operación',
    'Esta acción afecta toda la operación del negocio. Ingresa la contraseña de super administrador para continuar.',
    async (password) => {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const EXPECTED = '2154b4141e54eafe7665cf35879e056764c40b170de14dddf03c0b5fa232124e';
        if (hashHex === EXPECTED) {
          const select = document.getElementById('cfg-business-structure-mode');
          const btn = document.getElementById('btn-unlock-structure-mode');
          if (select) { select.disabled = false; select.style.opacity = ''; select.style.cursor = ''; }
          if (btn) { btn.textContent = '🔓 Desbloqueado'; btn.disabled = true; }
          showToast('Modo de operación desbloqueado. Guarda la configuración para aplicar el cambio.', 'success');
          return true;
        }
        showToast('Contraseña incorrecta', 'error');
        return false;
      } catch (err) {
        showToast(err.message || 'Error al verificar contraseña', 'error');
        return false;
      }
    }
  );
}

function showSuperAdminPasswordModal(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:1rem;padding:2rem;max-width:420px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,0.5)">
      <h3 style="margin:0 0 0.4rem;font-size:1.1rem">🔐 ${title}</h3>
      <p style="color:var(--text2);margin:0 0 1.25rem;font-size:0.88rem;line-height:1.5">${message}</p>
      <input type="password" id="super-admin-pwd-input" class="form-input" placeholder="Contraseña de super administrador" style="margin-bottom:1rem;width:100%;box-sizing:border-box">
      <div style="display:flex;gap:0.75rem;justify-content:flex-end">
        <button id="super-admin-cancel-btn" class="btn-secondary">Cancelar</button>
        <button id="super-admin-confirm-btn" class="btn-primary">Confirmar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#super-admin-pwd-input');
  input.focus();
  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('#super-admin-cancel-btn').addEventListener('click', close);
  overlay.querySelector('#super-admin-confirm-btn').addEventListener('click', async () => {
    const pwd = input.value;
    if (!pwd) { showToast('Ingresa la contraseña', 'warning'); return; }
    const ok = await onConfirm(pwd);
    if (ok) close();
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const pwd = input.value;
      if (!pwd) { showToast('Ingresa la contraseña', 'warning'); return; }
      const ok = await onConfirm(pwd);
      if (ok) close();
    }
    if (e.key === 'Escape') close();
  });
}

window.unlockBusinessStructureMode = unlockBusinessStructureMode;

function handleActiveBranchDraftChange() {
  const branchSelect = document.getElementById('cfg-active-branch');
  const registerSelect = document.getElementById('cfg-active-cash-register');
  if (!branchSelect || !registerSelect) return;
  const branchId = Number(branchSelect.value || 0);
  const registers = getCashRegistersForBranch(branchId);
  registerSelect.innerHTML = registers.map((item) => `<option value="${item.id}">${item.nombre}${item.codigo ? ` · ${item.codigo}` : ''}</option>`).join('');
  if (registers[0]?.id) {
    registerSelect.value = String(registers[0].id);
  }
}

async function applyActiveBusinessStructure() {
  const branchId = Number(document.getElementById('cfg-active-branch')?.value || 0);
  const cashRegisterId = Number(document.getElementById('cfg-active-cash-register')?.value || 0);
  if (!branchId || !cashRegisterId) {
    showToast('Selecciona una sucursal y una caja para continuar.', 'warning');
    return;
  }
  if (Array.isArray(DB.saleItems) && DB.saleItems.length) {
    const confirmed = window.confirm('Hay un pedido en curso. Si cambias de sucursal o caja, se limpiará ese pedido actual. ¿Deseas continuar?');
    if (!confirmed) return;
    if (typeof cancelSale === 'function') cancelSale();
  }
  try {
    const response = await api.setActiveBusinessStructure({
      branchId,
      cashRegisterId,
      ...getActorPayload()
    });
    DB.config = { ...DB.config, ...(response.config || {}) };
    DB.sucursales = response.sucursales || DB.sucursales || [];
    DB.cajasSucursal = response.cajasSucursal || DB.cajasSucursal || [];
    syncBusinessStructureControls();
    syncCajaState();
    showToast(`Ahora trabajas en ${DB.config.activeBranchName || 'la sucursal'} / ${DB.config.activeCashRegisterName || 'la caja'}.`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo cambiar la sucursal o caja activa.', 'error');
  }
}

async function createBranchFromConfig() {
  const nombre = String(document.getElementById('cfg-new-branch-name')?.value || '').trim();
  const codigo = String(document.getElementById('cfg-new-branch-code')?.value || '').trim();
  if (!nombre) {
    showToast('Escribe el nombre de la sucursal.', 'warning');
    return;
  }
  try {
    const response = await api.createBranch({
      nombre,
      codigo,
      ...getActorPayload()
    });
    DB.sucursales = response.sucursales || DB.sucursales || [];
    document.getElementById('cfg-new-branch-name').value = '';
    document.getElementById('cfg-new-branch-code').value = '';
    syncBusinessStructureControls();
    showToast(`Sucursal creada: ${response.sucursal?.nombre || nombre}`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo crear la sucursal.', 'error');
  }
}

async function createCashRegisterFromConfig() {
  const branchId = Number(document.getElementById('cfg-active-branch')?.value || DB.config?.activeBranchId || 0);
  const nombre = String(document.getElementById('cfg-new-cash-register-name')?.value || '').trim();
  const codigo = String(document.getElementById('cfg-new-cash-register-code')?.value || '').trim();
  if (!branchId || !nombre) {
    showToast('Selecciona una sucursal y escribe el nombre de la caja.', 'warning');
    return;
  }
  try {
    const response = await api.createCashRegister({
      branchId,
      nombre,
      codigo,
      ...getActorPayload()
    });
    DB.cajasSucursal = response.cajasSucursal || DB.cajasSucursal || [];
    document.getElementById('cfg-new-cash-register-name').value = '';
    document.getElementById('cfg-new-cash-register-code').value = '';
    syncBusinessStructureControls();
    showToast(`Caja creada: ${response.caja?.nombre || nombre}`, 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo crear la caja.', 'error');
  }
}

async function deleteBranchFromConfig(id, nombre) {
  if (!confirm(`¿Eliminar la sucursal "${nombre}"?\n\nTodas sus cajas también quedarán inactivas.\nEsta acción no se puede deshacer.`)) return;
  try {
    const response = await fetch(`/api/branches/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getTecnoCajaAuthToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(getActorPayload())
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al eliminar');
    DB.sucursales = data.sucursales || DB.sucursales;
    DB.cajasSucursal = data.cajasSucursal || DB.cajasSucursal;
    syncBusinessStructureControls();
    renderAdminDeleteLists();
    showToast(`Sucursal eliminada: ${nombre}`, 'success');
  } catch (e) {
    showToast(e.message || 'No se pudo eliminar la sucursal.', 'error');
  }
}

async function deleteCashRegisterFromConfig(id, nombre) {
  if (!confirm(`¿Eliminar la caja "${nombre}"?\n\nEsta acción no se puede deshacer.`)) return;
  try {
    const response = await fetch(`/api/cash-registers/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getTecnoCajaAuthToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(getActorPayload())
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al eliminar');
    DB.cajasSucursal = data.cajasSucursal || DB.cajasSucursal;
    syncBusinessStructureControls();
    renderAdminDeleteLists();
    showToast(`Caja eliminada: ${nombre}`, 'success');
  } catch (e) {
    showToast(e.message || 'No se pudo eliminar la caja.', 'error');
  }
}

function renderAdminDeleteLists() {
  const isAdmin = getCurrentUserRoleCode() === 'administrador_general';
  const branchList = document.getElementById('cfg-admin-branch-list');
  const cajaList = document.getElementById('cfg-admin-caja-list');
  const branchSection = document.getElementById('cfg-admin-delete-section');
  if (branchSection) branchSection.classList.toggle('hidden', !isAdmin);
  if (!isAdmin) return;

  const activeBranchId = Number(DB.config?.activeBranchId || 0);
  const activeCajaId = Number(DB.config?.activeCashRegisterId || 0);

  if (branchList) {
    const branches = DB.sucursales || [];
    branchList.innerHTML = branches.map(b => {
      const isActive = Number(b.id) === activeBranchId;
      return `<div class="admin-delete-row">
        <span>${b.nombre}${b.codigo ? ` · ${b.codigo}` : ''}${isActive ? ' <em style="color:var(--success);font-size:0.78rem">(activa)</em>' : ''}</span>
        <button class="admin-delete-btn" onclick="deleteBranchFromConfig(${b.id}, '${String(b.nombre).replace(/'/g, "\\'")}')"
          ${isActive ? 'disabled title="Cambia la sucursal activa primero"' : ''}>Eliminar</button>
      </div>`;
    }).join('') || '<p style="color:var(--text-muted);font-size:0.85rem">No hay sucursales.</p>';
  }

  if (cajaList) {
    const cajas = DB.cajasSucursal || [];
    cajaList.innerHTML = cajas.map(c => {
      const isActive = Number(c.id) === activeCajaId;
      const branchName = (DB.sucursales || []).find(b => Number(b.id) === Number(c.branchId || c.branch_id))?.nombre || '';
      return `<div class="admin-delete-row">
        <span>${c.nombre}${branchName ? ` <small style="opacity:.6">· ${branchName}</small>` : ''}${isActive ? ' <em style="color:var(--success);font-size:0.78rem">(activa)</em>' : ''}</span>
        <button class="admin-delete-btn" onclick="deleteCashRegisterFromConfig(${c.id}, '${String(c.nombre).replace(/'/g, "\\'")}')"
          ${isActive ? 'disabled title="Cambia la caja activa primero"' : ''}>Eliminar</button>
      </div>`;
    }).join('') || '<p style="color:var(--text-muted);font-size:0.85rem">No hay cajas.</p>';
  }
}

function syncConfigLicenseSummary() {
  const cfg = DB.config || {};
  const licenseReadonly = document.getElementById('cfg-license-readonly');
  if (licenseReadonly) {
    licenseReadonly.value = cfg.licenseStatus === 'active'
      ? appText('license.active', 'Licencia activa')
      : (cfg.licenseStatus === 'suspended'
          ? appText('license.suspended', 'Licencia suspendida')
          : (cfg.trialExpired
              ? appText('license.expired', 'Prueba vencida')
              : fillText(appText('license.trialShort', 'Prueba: {days} día(s)'), { days: Number(cfg.trialDaysLeft || 0) })));
  }
}

function syncWhatsAppGuidePreference(enabled) {
  DB.config = { ...DB.config, whatsappPasteGuideEnabled: Boolean(enabled) };
  const guideToggle = document.getElementById('cfg-whatsapp-guide-enabled');
  if (guideToggle) {
    guideToggle.checked = Boolean(enabled);
  }
}

if (window.novaDesktop?.onWhatsAppGuidePreferenceChanged) {
  window.novaDesktop.onWhatsAppGuidePreferenceChanged((payload) => {
    syncWhatsAppGuidePreference(Boolean(payload?.enabled));
    showToast(
      Boolean(payload?.enabled)
        ? 'La guía de WhatsApp fue reactivada.'
        : 'La guía de WhatsApp fue desactivada por ahora.',
      'success'
    );
  });
}

async function refreshPrinterOptions(forceToast = false) {
  const select = document.getElementById('cfg-printer-name');
  if (!select) return;

  const selectedPrinter = select.dataset.selectedPrinter ?? DB.config?.receiptPrinterName ?? '';
  const fallbackOption = '<option value="">Usar impresora predeterminada</option>';

  if (!window.novaDesktop?.listPrinters) {
    select.innerHTML = `${fallbackOption}<option value="" disabled>Disponible solo en la app de escritorio</option>`;
    select.value = '';
    return;
  }

  try {
    const result = await window.novaDesktop.listPrinters();
    const printers = Array.isArray(result?.printers) ? result.printers : [];
    select.innerHTML = fallbackOption + printers.map((printer) => {
      const isDefault = printer.isDefault ? ' (Predeterminada)' : '';
      return `<option value="${printer.name}">${printer.name}${isDefault}</option>`;
    }).join('');

    select.value = printers.some((printer) => printer.name === selectedPrinter) ? selectedPrinter : '';
    select.dataset.selectedPrinter = select.value;

    if (forceToast) {
      showToast(printers.length ? 'Lista de impresoras actualizada.' : 'No se encontraron impresoras disponibles.', printers.length ? 'success' : 'warning');
    }
  } catch (error) {
    select.innerHTML = `${fallbackOption}<option value="" disabled>Error al cargar impresoras</option>`;
    select.value = '';
    if (forceToast) showToast(error.message || 'No se pudieron cargar las impresoras.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAVETA REGISTRADORA — Funciones de configuración
// ─────────────────────────────────────────────────────────────────────────────

/** Muestra/oculta los campos según el método de conexión seleccionado */
function syncDrawerMethodFields() {
  const method = document.getElementById('cfg-drawer-method')?.value || 'escpos';
  const escposFields  = document.getElementById('cfg-drawer-escpos-fields');
  const networkFields = document.getElementById('cfg-drawer-network-fields');
  const serialFields  = document.getElementById('cfg-drawer-serial-fields');
  if (escposFields)  escposFields.style.display  = method === 'escpos'   ? '' : 'none';
  if (networkFields) networkFields.style.display = method === 'network'  ? '' : 'none';
  if (serialFields)  serialFields.style.display  = method === 'serial'   ? '' : 'none';
}

function isGenericTextOnlyPrinter(name = '') {
  return /generic\s*\/?\s*text\s*only/i.test(String(name || '').trim());
}

function resolveDrawerPrinterName(rawPrinterName = '', fallbackPrinterName = '') {
  const drawerPrinterName = String(rawPrinterName || '').trim();
  const receiptPrinterName = String(fallbackPrinterName || '').trim();

  if (!drawerPrinterName) return receiptPrinterName;
  if (isGenericTextOnlyPrinter(drawerPrinterName) && receiptPrinterName && !isGenericTextOnlyPrinter(receiptPrinterName)) {
    return receiptPrinterName;
  }
  return drawerPrinterName;
}

/** Carga las impresoras disponibles en el selector de gaveta */
async function refreshDrawerPrinterOptions(forceToast = false) {
  const select = document.getElementById('cfg-drawer-printer');
  if (!select) return;
  const fallback = '<option value="">Usar la misma de recibos</option>';
  if (!window.novaDesktop?.listPrinters) {
    select.innerHTML = `${fallback}<option value="" disabled>Solo disponible en la app de escritorio</option>`;
    return;
  }
  try {
    const result = await window.novaDesktop.listPrinters();
    const printers = Array.isArray(result?.printers) ? result.printers : [];
    select.innerHTML = fallback + printers.map(p => {
      const isGeneric = isGenericTextOnlyPrinter(p.name);
      const suffix = isGeneric
        ? ' (No recomendada para gaveta)'
        : (p.isDefault ? ' (Predeterminada)' : '');
      return `<option value="${p.name}">${p.name}${suffix}</option>`;
    }).join('');
    const saved = select.dataset.selectedPrinter ?? DB.config?.cashDrawerPrinterName ?? '';
    select.value = printers.some(p => p.name === saved) ? saved : '';
    if (forceToast) {
      showToast(printers.length ? 'Impresoras actualizadas.' : 'No se encontraron impresoras.', printers.length ? 'success' : 'warning');
    }
  } catch (err) {
    select.innerHTML = `${fallback}<option value="" disabled>Error al cargar impresoras</option>`;
    if (forceToast) {
      showToast(err.message || 'Error cargando impresoras.', 'error');
    }
  }
}

/** Prueba la apertura de gaveta desde la pantalla de configuración */
async function testCashDrawerConfig() {
  if (!window.novaDesktop?.testCashDrawer) {
    showToast('Esta función solo está disponible en la app de escritorio.', 'warning');
    return;
  }
  const btn    = document.getElementById('cfg-btn-test-drawer');
  const result = document.getElementById('cfg-drawer-test-result');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Abriendo...'; }
  if (result) result.textContent = '';

  const cfg = {
    method:       document.getElementById('cfg-drawer-method')?.value || 'escpos',
    printerName:  resolveDrawerPrinterName(
      document.getElementById('cfg-drawer-printer')?.value || '',
      DB.config?.receiptPrinterName || ''
    ),
    pin:          Number(document.getElementById('cfg-drawer-pin')?.value || 0),
    networkHost:  document.getElementById('cfg-drawer-network-host')?.value || '',
    networkPort:  Number(document.getElementById('cfg-drawer-network-port')?.value || 9100),
    serialPort:   document.getElementById('cfg-drawer-serial-port')?.value || 'COM1',
  };

  try {
    const res = await window.novaDesktop.testCashDrawer(cfg);
    if (res.ok) {
      showToast('¡Gaveta abierta correctamente!', 'success');
      if (result) result.textContent = `✓ Gaveta abierta en ${res.elapsed || 0}ms`;
    } else {
      showToast(res.error || 'No se pudo abrir la gaveta.', 'error');
      if (result) result.textContent = `✗ ${res.error || 'Error desconocido'}`;
    }
  } catch (err) {
    showToast(err.message || 'Error al probar la gaveta.', 'error');
    if (result) result.textContent = `✗ ${err.message}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔓 Probar apertura de gaveta'; }
  }
}

function collectScaleDraftConfig() {
  return {
    type: document.getElementById('cfg-scale-type')?.value || DB.config?.scaleType || 'none',
    serialPort: document.getElementById('cfg-scale-serial-port')?.value || DB.config?.scaleSerialPort || '',
    baudRate: Number(document.getElementById('cfg-scale-serial-baud-rate')?.value || DB.config?.scaleSerialBaudRate || 9600),
    defaultUnit: document.getElementById('cfg-scale-default-unit')?.value || DB.config?.scaleDefaultUnit || 'kg',
    readPattern: document.getElementById('cfg-scale-read-pattern')?.value || DB.config?.scaleReadPattern || '',
    roundingDecimals: Number(document.getElementById('cfg-scale-rounding-decimals')?.value ?? DB.config?.scaleRoundingDecimals ?? 2),
    autoRead: Boolean(document.getElementById('cfg-scale-auto-read')?.checked ?? DB.config?.scaleAutoRead ?? true)
  };
}

function syncScaleMethodFields() {
  const scaleType = document.getElementById('cfg-scale-type')?.value || 'none';
  const serialFields = document.getElementById('cfg-scale-serial-fields');
  if (serialFields) {
    serialFields.style.display = scaleType === 'serial' ? '' : 'none';
  }
}

async function refreshScaleSerialPorts(forceToast = false) {
  const select = document.getElementById('cfg-scale-serial-port');
  if (!select) return;

  const defaultOption = '<option value="">Selecciona un puerto COM</option>';
  const scaleType = document.getElementById('cfg-scale-type')?.value || DB.config?.scaleType || 'none';
  const selectedPort = select.dataset.selectedPort ?? DB.config?.scaleSerialPort ?? '';

  if (!window.novaDesktop?.listScaleSerialPorts) {
    select.innerHTML = `${defaultOption}<option value="" disabled>Disponible solo en la app de escritorio</option>`;
    select.value = '';
    return;
  }

  try {
    const result = await window.novaDesktop.listScaleSerialPorts();
    const ports = Array.isArray(result?.ports) ? result.ports : [];
    select.innerHTML = defaultOption + ports.map((item) => {
      const value = item.path || item.port || '';
      const label = item.label || value || 'Puerto COM';
      return `<option value="${value}">${label}</option>`;
    }).join('');
    select.value = ports.some((item) => String(item.path || item.port || '') === String(selectedPort)) ? selectedPort : '';
    select.dataset.selectedPort = select.value;

    if (forceToast) {
      showToast(
        scaleType === 'serial'
          ? (ports.length ? 'Puertos COM actualizados.' : 'No se detectaron puertos COM.')
          : 'Lista de puertos preparada para cuando uses modo serial.',
        ports.length ? 'success' : 'warning'
      );
    }
  } catch (error) {
    select.innerHTML = `${defaultOption}<option value="" disabled>Error al cargar puertos</option>`;
    select.value = '';
    if (forceToast) {
      showToast(error.message || 'No se pudieron consultar los puertos COM.', 'error');
    }
  }
}

async function testScaleReadConfig() {
  const btn = document.getElementById('cfg-btn-test-scale');
  const resultEl = document.getElementById('cfg-scale-test-result');
  const config = collectScaleDraftConfig();
  const utils = window.TecnoCajaScaleUtils;

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Leyendo báscula...';
  }
  if (resultEl) resultEl.textContent = '';

  try {
    if (config.type === 'none') {
      throw new Error('Activa un tipo de báscula antes de probar la lectura.');
    }

    if (config.type === 'usb') {
      const unitLabel = utils?.getWeightUnitLabel
        ? utils.getWeightUnitLabel(config.defaultUnit)
        : config.defaultUnit;
      if (resultEl) {
        resultEl.textContent = `✓ El modo USB/HID está listo. Abre una venta por peso y coloca el cursor en la lectura automática (${unitLabel}).`;
      }
      showToast('Modo USB/HID listo para capturar peso desde la caja.', 'success');
      return;
    }

    if (!window.novaDesktop?.readScaleWeight) {
      throw new Error('La lectura serial solo está disponible en la app de escritorio.');
    }

    const response = await window.novaDesktop.readScaleWeight(config);
    if (!response?.ok) {
      throw new Error(response?.error || 'No se recibió lectura desde la báscula.');
    }

    const parsed = utils?.parseScaleReading
      ? utils.parseScaleReading(response.raw, {
          pattern: config.readPattern,
          defaultUnit: config.defaultUnit,
          decimals: config.roundingDecimals
        })
      : null;

    if (!parsed?.ok) {
      throw new Error(`Lectura recibida pero no reconocida: ${response.raw || 'sin datos'}`);
    }

    const label = `${utils?.formatValue ? utils.formatValue(parsed.value, parsed.decimals) : parsed.value} ${parsed.unit}`;
    if (resultEl) {
      resultEl.textContent = `✓ Lectura detectada en ${response.port || config.serialPort}: ${label}`;
    }
    showToast(`Peso detectado: ${label}`, 'success');
  } catch (error) {
    if (resultEl) resultEl.textContent = `✗ ${error.message || 'No se pudo leer la báscula.'}`;
    showToast(error.message || 'No se pudo leer la báscula.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚖️ Probar lectura de báscula';
    }
  }
}

function applyBranding() {
  const appName = (DB.config?.nombre || 'Tecno Caja').trim() || 'Tecno Caja';
  const appLogo = DB.config?.logo || '';
  const loginText = document.getElementById('login-logo-text');
  const sidebarText = document.getElementById('sidebar-logo-name');
  if (loginText) loginText.textContent = appName;
  if (sidebarText) sidebarText.textContent = appName;
  document.title = typeof window.translateUiString === 'function'
    ? window.translateUiString(`${appName} — Sistema Punto de Venta`)
    : `${appName} — Sistema Punto de Venta`;

  applyLogoState('login-logo-image', 'login-logo-icon', appLogo);
  applyLogoState('sidebar-logo-image', 'sidebar-logo-icon', appLogo);
  updateLogoPreview(appLogo);
  updateStaticUiTexts();
}

function applyBusinessDashboardConfig(profile, config) {
  const reportCards = config?.dashboard?.reportCards || {};
  const setText = (selector, value) => {
    if (!value) return;
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };

  setText('#module-reportes .report-card:nth-child(1) .report-card-header', reportCards.salesTitle);
  setText('#module-reportes .report-card:nth-child(1) .report-card-sub', reportCards.salesSubtitle);
  setText('#module-reportes .report-card:nth-child(2) .report-card-header', reportCards.profitTitle);
  setText('#module-reportes .report-card:nth-child(2) .report-card-sub', reportCards.profitSubtitle);
  setText('#module-reportes .report-card:nth-child(3) .report-card-header', reportCards.topTitle);
  setText('#module-reportes .report-card:nth-child(3) .report-card-sub', reportCards.topSubtitle);
  setText('#module-reportes .report-card:nth-child(4) .report-card-header', reportCards.taxTitle);
  setText('#module-reportes .report-card:nth-child(4) .report-card-sub', reportCards.taxSubtitle);
  setText('#module-reportes .report-panel-wide .report-panel-head h3', config?.dashboard?.trendTitle);
  setText('#module-reportes .report-panel-wide .report-panel-head p', config?.dashboard?.trendSubtitle);
  setText('#module-reportes .report-panel:not(.report-panel-wide) .report-panel-head h3', config?.dashboard?.paymentTitle);
  setText('#module-reportes .report-panel:not(.report-panel-wide) .report-panel-head p', config?.dashboard?.paymentSubtitle);
  setText('#module-reportes .report-panel-full .report-panel-head h3', config?.dashboard?.orderTypeTitle);
  setText('#module-reportes .report-panel-full .report-panel-head p', config?.dashboard?.orderTypeSubtitle);
}

function applyBusinessProfile() {
  const profile = DB.config?.businessProfile || null;
  const config = getBusinessRuntimeConfig();
  const html = document.documentElement;
  if (profile?.key) {
    html.dataset.businessType = profile.key;
  } else {
    delete html.dataset.businessType;
  }

  const titleEl = document.querySelector('.sales-catalog-title');
  const subtitleEl = document.querySelector('.sales-catalog-subtitle');
  const searchInput = document.getElementById('product-search');
  const quickMenuWrap = document.querySelector('.sales-pizza-mini');
  const quickMenuTitle = document.querySelector('.sales-pizza-mini-title');
  const quickMenuList = document.querySelector('.sales-pizza-mini-list');
  const configGuideTitle = document.getElementById('cfg-business-guide-title');
  const configGuideLines = document.getElementById('cfg-business-guide-lines');
  const configGuideHeading = document.getElementById('cfg-business-guide-heading');
  const productHeading = document.querySelector('#module-productos .module-header h2');
  const reportHeading = document.querySelector('#module-reportes .module-header h2');
  const mobileHeading = document.querySelector('#module-posmovil .module-header h2');

  if (titleEl) titleEl.textContent = '';
  if (subtitleEl) subtitleEl.textContent = '';
  if (searchInput) {
    searchInput.placeholder = profile?.searchPlaceholder || 'Escanear código o buscar producto... (F2)';
  }

  const menuItems = Array.isArray(profile?.quickMenuItems) ? profile.quickMenuItems : [];
  const shouldShowMenu = menuItems.length > 0;
  if (quickMenuWrap) quickMenuWrap.classList.toggle('hidden', !shouldShowMenu);
  if (quickMenuTitle) quickMenuTitle.textContent = profile?.quickMenuTitle || 'Guía rápida';
  if (quickMenuList) {
    quickMenuList.innerHTML = menuItems.map((item) => `<span>${item}</span>`).join('');
    if (profile?.quickMenuNote) {
      quickMenuList.innerHTML += `<span>${profile.quickMenuNote}</span>`;
    }
  }

  if (configGuideHeading) {
    configGuideHeading.textContent = profile?.label
      ? `${appText('settings.businessGuideHeading', 'Guía del Negocio')}: ${profile.label}`
      : appText('settings.businessGuideHeading', 'Guía del Negocio');
  }
  if (configGuideTitle) {
    configGuideTitle.textContent = getCurrentLanguage() === 'es'
      ? (profile?.quickMenuTitle || appText('settings.businessGuideTitle', 'Guía rápida del negocio'))
      : appText('settings.businessGuideTitle', 'Quick business guide');
  }
  if (configGuideLines) {
    const featureChips = getBusinessFeatureList().slice(0, 6).map((feature) => {
      const label = String(feature || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
      return `<span class="business-feature-chip">${label}</span>`;
    }).join('');
    const lines = [
      ...menuItems.map((item) => `<div class="pizza-menu-text">${item}</div>`),
      profile?.quickMenuNote ? `<div class="pizza-menu-note">${profile.quickMenuNote}</div>` : '',
      featureChips ? `<div class="business-feature-grid">${featureChips}</div>` : ''
    ].join('');
    configGuideLines.innerHTML = lines || `<div class="pizza-menu-text">${appText('settings.businessGuideEmpty', 'Configura el negocio y personaliza esta guía desde tu operación.')}</div>`;
  }

  if (productHeading) {
    productHeading.textContent = profile?.label ? `Productos · ${profile.label}` : 'Gestión de Productos';
  }
  if (reportHeading) {
    reportHeading.textContent = profile?.label ? `Reportes · ${profile.label}` : 'Reportes';
  }
  if (mobileHeading) {
    mobileHeading.textContent = profile?.label ? `POS Móvil · ${profile.label}` : 'POS Móvil por WiFi';
  }

  html.dataset.businessFeatures = getBusinessFeatureList().join(',');
  applyBusinessDashboardConfig(profile, config);

  if (!getUiPreferences().accent && profile?.accent && profile?.accentLight) {
    setAccent(profile.accent, profile.accentLight);
  }
}

function applyLicenseSnapshot(license = {}) {
  const status = String(license.status || DB.config?.licenseStatus || 'trial').trim().toLowerCase();
  DB.config.licenseStatus = status;
  DB.config.trialStartedAt = license.trialStartedAt ?? DB.config.trialStartedAt ?? null;
  DB.config.trialEndsAt = license.trialEndsAt ?? null;
  DB.config.trialDaysLeft = Number(license.daysLeft ?? DB.config?.trialDaysLeft ?? 0) || 0;
  DB.config.trialExpired = Boolean(license.expired || status === 'expired');
}

function getLicenseUiVariant() {
  const status = String(DB.config?.licenseStatus || 'trial').trim().toLowerCase();
  if (status === 'active') return 'active';
  if (status === 'suspended') return 'suspended';
  if (DB.config?.trialExpired) return 'expired';
  return 'trial';
}

function updateLicenseSupportActions() {
  const blocked = getLicenseUiVariant() === 'expired' || String(DB.config?.licenseStatus || '').trim().toLowerCase() === 'suspended';
  [
    document.getElementById('login-license-actions'),
    document.getElementById('cfg-license-actions')
  ].forEach((el) => {
    if (el) el.classList.toggle('hidden', !blocked);
  });
}

function stopLicenseWatcher() {
  if (licenseWatchTimer) {
    clearInterval(licenseWatchTimer);
    licenseWatchTimer = null;
  }
}

// ─── Estado interno de la pantalla de bloqueo ─────────────────────────────────
let _lbsLicenseUid = null;
let _lbsLicenseData = {};

// Socket.io listener para cambios de licencia en tiempo real desde el servidor
let _licenseSocket = null;
function connectLicenseSocket() {
  if (_licenseSocket || typeof io === 'undefined') return;
  try {
    _licenseSocket = io();
    _licenseSocket.on('license:status-changed', async (data) => {
      if (data.licenseUid) _lbsLicenseUid = data.licenseUid;
      applyLicenseSnapshot({
        status: data.status,
        suspended: data.suspended,
        expired: data.expired,
        trialEndsAt: data.trialEndsAt || null,
        canEnter: data.canEnter,
        planCode: data.planCode,
        planName: data.planName,
      });
      updateLicenseUI();
      syncConfigLicenseSummary();
      updateNotifications();
      if (data.canEnter === false) {
        await enforceBlockedLicense({
          status: data.status,
          suspended: data.suspended,
          expired: data.expired,
          canEnter: false,
          planCode: data.planCode,
          planName: data.planName,
          trialEndsAt: data.trialEndsAt,
          licenseUid: data.licenseUid,
        });
      } else if (data.canEnter === true && licenseBlockInProgress) {
        // Licencia reactivada desde el admin — ocultar pantalla bloqueada automáticamente
        licenseBlockInProgress = false;
        hideLicenseBlockedScreen();
        startLicenseWatcher();
        showToast('¡Licencia reactivada! Puedes iniciar sesión.', 'success');
        showLoginScreen();
      }
    });
    _licenseSocket.on('disconnect', () => {
      _licenseSocket = null;
    });
  } catch (_err) {
    _licenseSocket = null;
  }
}

// ─── Pantalla de bloqueo de licencia ──────────────────────────────────────────
function showLicenseBlockedScreen(license = {}) {
  const screen = document.getElementById('license-blocked-screen');
  if (!screen) return;

  const suspended = license.suspended || license.status === 'suspended';
  const validationBlocked = ['tamper', 'clock_rollback', 'offline_grace', 'device_limit', 'invalid_signature', 'missing_signature']
    .includes(String(license.blockedCode || '').trim().toLowerCase());
  const expired   = license.expired   || license.status === 'expired' || validationBlocked;

  // Icono
  const iconWrap = document.getElementById('lbs-icon-wrap');
  const iconBlock   = document.getElementById('lbs-icon-block');
  const iconWarning = document.getElementById('lbs-icon-warning');
  if (iconWrap) {
    iconWrap.className = 'lbs-icon-wrap ' + (suspended ? 'lbs-suspended' : 'lbs-expired');
  }
  if (iconBlock)   iconBlock.classList.toggle('hidden', !suspended);
  if (iconWarning) iconWarning.classList.toggle('hidden', suspended);

  // Título
  const title = document.getElementById('lbs-title');
  if (title) {
    title.textContent = suspended
      ? 'Cuenta Suspendida'
      : (validationBlocked ? 'Validación Requerida' : 'Licencia Requerida');
    title.classList.toggle('lbs-suspended-title', suspended);
  }

  // Mensaje
  const msg = document.getElementById('lbs-message');
  if (msg) {
    msg.textContent = license.message || (
      suspended
        ? 'Su cuenta ha sido suspendida desde la app de administrador. Comuníquese con soporte para verificar qué sucede y restaurar su acceso.'
        : 'Su período de prueba ha terminado o la licencia no es válida. Para seguir usando el sistema debe activar su licencia.'
    );
  }

  // Badge de estado
  const dot  = document.getElementById('lbs-status-dot');
  const text = document.getElementById('lbs-status-text');
  if (dot) {
    dot.className = 'lbs-status-dot ' + (suspended ? 'lbs-dot-suspended' : 'lbs-dot-expired');
  }
  if (text) {
    text.textContent = suspended
      ? 'Suspendida'
      : (validationBlocked ? 'Bloqueada' : 'Expirada');
  }

  // Info
  const bName = document.getElementById('lbs-business-name');
  const bPlan = document.getElementById('lbs-plan-name');
  const trialRow = document.getElementById('lbs-trial-row');
  const trialEnds = document.getElementById('lbs-trial-ends');
  if (bName) bName.textContent = DB.config?.nombre || license.businessName || '—';
  if (bPlan) bPlan.textContent = license.planName || DB.config?.planName || 'Tecno Caja Básico';
  if (trialRow) trialRow.style.display = 'none';

  _lbsLicenseData = { ...license };

  // Mostrar pantalla y ocultar todo lo demás
  screen.classList.remove('hidden');
  document.getElementById('app')?.classList.add('hidden');
  document.getElementById('login-screen')?.classList.add('hidden');
  document.getElementById('setup-screen')?.classList.add('hidden');
  document.getElementById('cash-gate-screen')?.classList.add('hidden');
}

function hideLicenseBlockedScreen() {
  document.getElementById('license-blocked-screen')?.classList.add('hidden');
}

// Botón ACTUALIZAR ESTADO
window.lbsRefreshStatus = async function () {
  const btn = document.getElementById('lbs-btn-refresh');
  const loading = document.getElementById('lbs-loading');
  if (btn) btn.disabled = true;
  if (loading) loading.classList.remove('hidden');
  try {
    const response = await api.getLicenseStatus({ refresh: true });
    if (response?.licenseUid) _lbsLicenseUid = response.licenseUid;
    if (response?.license) {
      applyLicenseSnapshot(response.license);
      updateLicenseUI();
      syncConfigLicenseSummary();
      if (response.license.canEnter === true) {
        hideLicenseBlockedScreen();
        licenseBlockInProgress = false;
        showToast('¡Licencia verificada! Puedes iniciar sesión.', 'success');
        showLoginScreen();
      } else {
        showLicenseBlockedScreen({
          ...response.license,
          licenseUid: response.licenseUid,
          businessName: response.businessName,
        });
      }
    }
  } catch (err) {
    showToast('No se pudo verificar el estado. Verifica tu conexión.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (loading) loading.classList.add('hidden');
  }
};

// Botón VERIFICAR POR WHATSAPP (igual que inversions_martinez)
window.lbsOpenWhatsApp = function () {
  const whatsappNumber = DEFAULT_LICENSE_WHATSAPP || '18292812877';
  const uid = _lbsLicenseUid || '—';
  const business = DB.config?.nombre || _lbsLicenseData?.businessName || 'Tecno Caja';
  const status = _lbsLicenseData?.status || DB.config?.licenseStatus || '';
  const esSuspendido = status === 'suspended';

  const mensaje = esSuspendido
    ? `Hola, mi sistema POS (${business}) aparece como SUSPENDIDO y no puedo entrar.\nUID de licencia: ${uid}\nPodrian verificar qué pasó y restaurar mi acceso?`
    : `Hola, necesito activar la licencia de mi sistema POS (${business}).\nUID de licencia: ${uid}\nPodrian ayudarme?`;

  const encoded = encodeURIComponent(mensaje);
  const url = `https://wa.me/${whatsappNumber}?text=${encoded}`;
  window.open(url, '_blank', 'noopener,noreferrer');
};

// Botón CERRAR SESIÓN
window.lbsLogout = async function () {
  hideLicenseBlockedScreen();
  licenseBlockInProgress = false;
  await doLogout();
};

async function enforceBlockedLicense(license = {}) {
  if (licenseBlockInProgress) return;
  licenseBlockInProgress = true;
  stopLicenseWatcher();
  applyLicenseSnapshot(license);
  updateLicenseUI();
  closeAllModals();

  if (DB.currentUser?.authProvider === 'google' && window.firebaseWebAuth?.signOut) {
    try { await window.firebaseWebAuth.signOut(); } catch (_e) {}
  }

  DB.currentUser = null;
  DB.saleItems = [];
  notificationsSeenCount = 0;
  pendingGoogleLinkSession = null;

  showLicenseBlockedScreen(license);
  // El watcher sigue corriendo para detectar cuando reactiven la licencia
  startLicenseWatcher();
}

async function refreshRemoteLicenseStatus(options = {}) {
  try {
    const response = await api.getLicenseStatus();
    if (response?.license) {
      applyLicenseSnapshot(response.license);
      updateLicenseUI();
      syncConfigLicenseSummary();
      updateNotifications();
      const setupVisible = !document.getElementById('setup-screen')?.classList.contains('hidden');
      if (response.license.canEnter === false && options.enforce !== false && !setupVisible) {
        await enforceBlockedLicense(response.license);
      }
    }
    return response;
  } catch (error) {
    if (!options.silent) {
      showToast(error.message || 'No se pudo verificar la licencia remota.', 'warning');
    }
    return null;
  }
}

function startLicenseWatcher() {
  stopLicenseWatcher();
  connectLicenseSocket();
  refreshRemoteLicenseStatus({ silent: true });
  licenseWatchTimer = setInterval(() => {
    refreshRemoteLicenseStatus({ silent: true });
  }, 5 * 60 * 1000);
}

function updateLicenseUI() {
  const pill = document.getElementById('license-pill');
  const loginHint = document.getElementById('login-license-hint');
  const status = String(DB.config?.licenseStatus || 'trial').trim().toLowerCase();
  const daysLeft = Number(DB.config?.trialDaysLeft || 0);
  const variant = getLicenseUiVariant();
  let text = '';

  if (status === 'active') {
    text = appText('license.active', 'Licencia activa');
  } else if (status === 'suspended') {
    text = appText('license.suspended', 'Licencia suspendida');
  } else if (DB.config?.trialExpired) {
    text = appText('license.expired', 'Prueba vencida');
  } else {
    text = fillText(appText('license.trialShort', 'Prueba: {days} día(s)'), { days: daysLeft });
  }

  if (pill) {
    pill.textContent = text;
    pill.className = `license-pill ${variant}`;
    pill.classList.remove('hidden');
  }

  if (loginHint) {
    loginHint.textContent = status === 'active'
      ? appText('license.active', 'Licencia activa')
      : (status === 'suspended'
          ? appText('license.suspendedLong', 'La licencia fue suspendida desde tu app de administrador.')
          : (DB.config?.trialExpired
              ? appText('license.expiredLong', 'La prueba del sistema expiró.')
              : fillText(appText('license.trialLong', 'Prueba completa disponible por {days} día(s).'), { days: daysLeft })));
    loginHint.className = `login-status-pill ${variant}`;
    loginHint.classList.remove('hidden');
  }
  updateLicenseSupportActions();
}

function syncCashStartupGate() {
  const gate = document.getElementById('cash-gate-screen');
  if (!gate) return;
  const shouldBlock = Boolean(
    DB.currentUser
    && DB.config?.requireCashOpenBeforeUse
    && !(DB.config?.cajaAbierta || DB.caja?.abierta)
  );
  gate.classList.toggle('hidden', !shouldBlock);
}

function applyLogoState(imageId, fallbackId, logoData) {
  const image = document.getElementById(imageId);
  const fallback = document.getElementById(fallbackId);
  if (!image || !fallback) return;
  if (logoData) {
    image.src = logoData;
    image.classList.remove('hidden');
    fallback.classList.add('hidden');
    return;
  }
  image.removeAttribute('src');
  image.classList.add('hidden');
  fallback.classList.remove('hidden');
}

function updateLogoPreview(logoData) {
  const preview = document.getElementById('cfg-logo-preview');
  if (!preview) return;
  preview.innerHTML = logoData ? `<img src="${logoData}" alt="Vista previa del logo">` : '⚡';
}

function renderSetupChoiceCards(containerId, items, selectedValue, type) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = items.map((item) => `
    <button type="button" class="setup-choice-card ${selectedValue === item.value ? 'active' : ''}" data-value="${item.value}">
      <div class="setup-choice-accent" style="background:linear-gradient(135deg, ${item.accent || 'var(--accent)'}, ${item.accentLight || 'var(--accent-light)'})"></div>
      <strong>${item.label}</strong>
      <span>${item.subtitle || ''}</span>
    </button>
  `).join('');
  box.querySelectorAll('.setup-choice-card').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.value;
      if (type === 'language') {
        setupWizard.language = value;
        DB.config.idioma = value;
        updateStaticUiTexts();
        renderSetupWizard();
      } else if (type === 'business') {
        setupWizard.businessType = value;
        renderSetupWizard();
      } else if (type === 'structure') {
        setupWizard.businessStructureMode = normalizeBusinessStructureMode(value);
        renderSetupWizard();
      }
    });
  });
}

function renderSetupWizard() {
  const ss = setupState || {};
  const languageSubtitles = {
    es: 'Ideal para República Dominicana y LATAM',
    en: 'For English-speaking teams',
    fr: 'Pour équipes francophones',
    pt: 'Ideal para equipos en portugués',
    de: 'Geeignet für deutschsprachige Teams',
    it: 'Pensato per squadre italiane',
    nl: 'Voor Nederlandstalige teams',
    ru: 'Для русскоязычных команд',
    zh: '适合中文团队',
    ar: 'مناسب للفرق الناطقة بالعربية'
  };
  const languageItems = (ss.languages || []).map((item) => ({
    ...item,
    subtitle: languageSubtitles[item.value] || item.label
  }));
  const copy = getUiText();
  const structureItems = Array.isArray(copy.setupStructureOptions) && copy.setupStructureOptions.length
    ? copy.setupStructureOptions
    : (BASE_UI_TEXT.setupStructureOptions || []);
  renderSetupChoiceCards('setup-language-options', languageItems, setupWizard.language, 'language');
  renderSetupChoiceCards('setup-business-options', ss.businessTypes || [], setupWizard.businessType, 'business');
  renderSetupChoiceCards('setup-structure-options', structureItems, normalizeBusinessStructureMode(setupWizard.businessStructureMode), 'structure');

  const currencySelect = document.getElementById('setup-currency');
  if (currencySelect) {
    currencySelect.innerHTML = (ss.currencies || []).map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
    if (!currencySelect.value) currencySelect.value = setupWizard.forceReset ? 'RD$' : (ss.config?.moneda || 'RD$');
  }

  const defaultName = document.getElementById('setup-business-name');
  if (defaultName && !defaultName.value) {
    defaultName.value = setupWizard.forceReset ? '' : (ss.config?.nombre === 'Tecno Caja' ? '' : (ss.config?.nombre || ''));
  }
  const taxRate = document.getElementById('setup-tax-rate');
  if (taxRate && !taxRate.value) taxRate.value = String(setupWizard.forceReset ? 18 : (ss.config?.itbis ?? 18));
  applyGoogleSetupPrefill();
  updateSetupStepUi();
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(document.body);
}

function updateSetupStepUi() {
  document.querySelectorAll('.setup-step-panel').forEach((panel, index) => {
    panel.classList.toggle('active', index === setupWizard.step);
  });
  document.querySelectorAll('#setup-steps .setup-step-dot').forEach((dot, index) => {
    dot.classList.toggle('active', index === setupWizard.step);
  });
  const backBtn = document.getElementById('setup-back-btn');
  const nextBtn = document.getElementById('setup-next-btn');
  const finishBtn = document.getElementById('setup-finish-btn');
  if (backBtn) backBtn.disabled = setupWizard.step === 0;
  if (nextBtn) nextBtn.classList.toggle('hidden', setupWizard.step >= 5);
  if (finishBtn) finishBtn.classList.toggle('hidden', setupWizard.step < 5);
}

function validateSetupStep(step = setupWizard.step) {
  if (step === 2) {
    const adminName = document.getElementById('setup-admin-name')?.value.trim() || '';
    const adminUser = document.getElementById('setup-admin-user')?.value.trim() || '';
    const adminPassword = document.getElementById('setup-admin-pass')?.value.trim() || '';
    const adminEmail = document.getElementById('setup-admin-email')?.value.trim() || '';
    const requiresLocalPassword = !hasGoogleSetupAuth();
    if (!adminName || !adminUser || (requiresLocalPassword && !adminPassword)) {
      showToast('Completa los datos del administrador para continuar.', 'warning');
      return false;
    }
    if (!hasGoogleSetupAuth() && !adminEmail) {
      showToast('El correo electrónico es requerido para registrar tu licencia y poder gestionar el sistema desde la app de administrador.', 'warning');
      document.getElementById('setup-admin-email')?.focus();
      return false;
    }
    if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      showToast('El correo electrónico no tiene un formato válido.', 'warning');
      document.getElementById('setup-admin-email')?.focus();
      return false;
    }
  }
  if (step === 3) {
    const businessName = document.getElementById('setup-business-name')?.value.trim();
    if (!businessName) {
      showToast('Escribe el nombre del negocio para seguir.', 'warning');
      return false;
    }
  }
  return true;
}

function goToSetupStep(direction) {
  const nextStep = setupWizard.step + direction;
  if (direction > 0 && !validateSetupStep(setupWizard.step)) return;
  setupWizard.step = Math.max(0, Math.min(5, nextStep));
  updateSetupStepUi();
}

async function refreshSetupPrinterOptions() {
  const select = document.getElementById('setup-printer-name');
  if (!select) return;
  if (!window.novaDesktop?.listPrinters) {
    const labels = getUiText().setupOptionLabels || {};
    select.innerHTML = `<option value="">${labels.defaultPrinter || 'Usar impresora predeterminada'}</option><option value="" disabled>Disponible solo en la app de escritorio</option>`;
    return;
  }
  try {
    const result = await window.novaDesktop.listPrinters();
    const printers = Array.isArray(result?.printers) ? result.printers : [];
    const labels = getUiText().setupOptionLabels || {};
    select.innerHTML = `<option value="">${labels.defaultPrinter || 'Usar impresora predeterminada'}</option>` + printers.map((printer) => `
      <option value="${printer.name}">${printer.name}${printer.isDefault ? ' (Predeterminada)' : ''}</option>
    `).join('');
  } catch (_error) {
    select.innerHTML = '<option value="">Usar impresora predeterminada</option><option value="" disabled>Error al cargar impresoras</option>';
  }
}

async function completeInitialSetup() {
  if (!validateSetupStep(2) || !validateSetupStep(3)) return;
  const finishBtn = document.getElementById('setup-finish-btn');
  if (finishBtn) finishBtn.disabled = true;
  const sessionLanguage = setupWizard.language || DB.config?.idioma || 'es';
  const adminUser = document.getElementById('setup-admin-user')?.value.trim() || '';
  const adminPassword = document.getElementById('setup-admin-pass')?.value.trim() || '';
  const googleIdToken = setupWizard.googleAuth?.idToken || '';
  try {
    const response = await api.completeInitialSetup({
      language: sessionLanguage,
      adminName: document.getElementById('setup-admin-name')?.value.trim(),
      adminUser,
      adminEmail: document.getElementById('setup-admin-email')?.value.trim(),
      adminPassword,
      googleIdToken,
      businessType: setupWizard.businessType,
      businessStructureMode: normalizeBusinessStructureMode(setupWizard.businessStructureMode),
      currency: document.getElementById('setup-currency')?.value || 'RD$',
      businessName: document.getElementById('setup-business-name')?.value.trim(),
      businessRnc: document.getElementById('setup-business-rnc')?.value.trim(),
      businessAddress: document.getElementById('setup-business-address')?.value.trim(),
      businessPhone: document.getElementById('setup-business-phone')?.value.trim(),
      taxRate: Number(document.getElementById('setup-tax-rate')?.value || 0),
      receiptPrintMode: document.getElementById('setup-print-mode')?.value || 'dialog',
      receiptPrinterName: document.getElementById('setup-printer-name')?.value || '',
      receiptPaperSize: document.getElementById('setup-paper-size')?.value || '80mm',
      openingAmount: Number(document.getElementById('setup-opening-amount')?.value || 0),
      openingNotes: document.getElementById('setup-opening-notes')?.value.trim(),
      forceReset: setupWizard.forceReset,
      securityPassword: setupWizard.securityPassword,
      networkKey: setupWizard.networkKey || ''
    });
    await activateAuthenticatedSession(response, sessionLanguage);
    setupWizard.forceReset = false;
    setupWizard.securityPassword = '';
    setupWizard.googleAuth = null;
    showToast('Configuración inicial completada.', 'success');
    if (response?.networkHosting?.restartRequired) {
      showToast('El modo en red quedó preparado. Reinicia Tecno Caja en la PC principal antes de vincular la segunda caja.', 'warning');
    }
  } catch (error) {
    if (String(error?.message || '').includes('El sistema ya fue configurado')) {
      try {
        setupState = await api.getSetupStatus();
        if (setupState?.config) {
          DB.config = { ...DB.config, ...setupState.config };
        }
        setupWizard.forceReset = false;
        setupWizard.securityPassword = '';
        setupWizard.googleAuth = null;
        setupWizard.language = DB.config?.idioma || setupWizard.language || 'es';
        setupWizard.businessType = DB.config?.tipoNegocio || setupWizard.businessType || 'pizzeria';
        setupWizard.businessStructureMode = normalizeBusinessStructureMode(DB.config?.businessStructureMode || setupWizard.businessStructureMode);
        updateStaticUiTexts();
        applyBranding();
        applyBusinessProfile();
        updateLicenseUI();
        if (googleIdToken) {
          try {
            const response = await api.loginWithGoogle(googleIdToken);
            await activateAuthenticatedSession(response, sessionLanguage);
            showToast('El sistema ya estaba configurado. Entraste directamente al modulo de ventas.', 'success');
            return;
          } catch (loginError) {
            console.warn('No se pudo iniciar sesion con Google tras detectar una app ya configurada:', loginError?.message || loginError);
          }
        }
        if (adminUser && adminPassword) {
          try {
            const response = await api.login(adminUser, adminPassword);
            await activateAuthenticatedSession(response, sessionLanguage);
            showToast('El sistema ya estaba configurado. Entraste directamente al modulo de ventas.', 'success');
            return;
          } catch (loginError) {
            console.warn('No se pudo iniciar sesion con las credenciales escritas tras detectar una app ya configurada:', loginError?.message || loginError);
          }
        }
        showLoginScreen();
        showToast(getConfiguredAppSetupMessage(), 'warning');
        return;
      } catch (refreshError) {
        showToast(refreshError.message || error.message, 'error');
        return;
      }
    }
    showToast(error.message, 'error');
  } finally {
    if (finishBtn) finishBtn.disabled = false;
  }
}

async function submitCashGate() {
  const amount = Number(document.getElementById('cash-gate-amount')?.value || 0);
  const obs = document.getElementById('cash-gate-notes')?.value?.trim() || 'Apertura de caja';
  try {
    const result = await api.openCash({
      monto: amount,
      obs,
      ...getBusinessStructurePayload(),
      ...getActorPayload()
    });
    // Actualizar solo el estado de caja sin recargar todo el bootstrap
    if (result?.config) {
      DB.config = { ...DB.config, ...result.config };
    } else {
      DB.config.cajaAbierta = true;
      DB.config.cajaMonto = amount;
    }
    DB.caja = { ...DB.caja, abierta: true, sessionId: result?.sessionId || DB.caja?.sessionId || null };
    syncCajaState();
    applyRolePermissions();
    const gate = document.getElementById('cash-gate-screen');
    if (gate) gate.classList.add('hidden');
    showToast('Caja abierta correctamente.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function initializeStartupFlow() {
  applyUiPreferences();
  applyBranding();
  if (typeof window.observeUiTranslations === 'function') window.observeUiTranslations();
  try {
    setupState = await api.getSetupStatus();
    if (setupState?.config) {
      DB.config = { ...DB.config, ...setupState.config };
    }
    setupWizard.language = DB.config?.idioma || 'es';
    setupWizard.businessType = DB.config?.tipoNegocio || 'pizzeria';
    setupWizard.businessStructureMode = normalizeBusinessStructureMode(DB.config?.businessStructureMode);
    updateStaticUiTexts();
    applyBranding();
    applyBusinessProfile();
    updateLicenseUI();
    if (setupState?.setupRequired) {
      startSetupWizardSession();
      return;
    }
    showLoginScreen();
  } catch (error) {
    showLoginScreen();
    if (typeof showToast === 'function') {
      showToast(error.message || 'No se pudo preparar el inicio del sistema.', 'error');
    } else {
      console.error(error);
    }
  }
}

function triggerLogoUpload() {
  document.getElementById('cfg-logo-input')?.click();
}

function clearLogoSelection() {
  const logoInput = document.getElementById('cfg-logo-input');
  if (logoInput) {
    logoInput.value = '';
    logoInput.dataset.logoData = '';
  }
  DB.config.logo = '';
  updateLogoPreview('');
  applyBranding();
}

async function handleLogoUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Selecciona una imagen válida para el logo.', 'warning');
    event.target.value = '';
    return;
  }

  const dataUrl = await fileToDataUrl(file);
  event.target.dataset.logoData = dataUrl;
  DB.config.logo = dataUrl;
  updateLogoPreview(dataUrl);
  applyBranding();
  showToast('Logo cargado. Guarda los cambios para dejarlo fijo.', 'success');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(file);
  });
}

function togglePasswordVisibility(inputId, button) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  if (button) button.textContent = isPassword ? '🙈' : '👁';
}

function openGoogleLinkModal() {
  if (!pendingGoogleLinkSession?.idToken) {
    showToast('Primero elige la cuenta de Google que quieres vincular.', 'warning');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  if (!overlay || !title || !body || !footer) return;

  title.textContent = 'Vincular cuenta Google';
  body.innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full">
        <label>Cuenta de Google detectada</label>
        <input type="text" class="form-input" value="${pendingGoogleLinkSession.email || pendingGoogleLinkSession.name || 'Cuenta seleccionada'}" disabled>
      </div>
      <div class="form-group span-full">
        <p style="color:var(--text2);font-size:0.84rem;line-height:1.5;margin-bottom:0">
          Esta cuenta todavía no está vinculada. Escribe tu usuario y contraseña actual del POS para enlazarla y entrar desde ahora con Google.
        </p>
      </div>
      <div class="form-group">
        <label>Usuario actual</label>
        <input type="text" id="google-link-user" class="form-input" placeholder="Ej: admin">
      </div>
      <div class="form-group">
        <label>Contraseña actual</label>
        <div class="password-field">
          <input type="password" id="google-link-password" class="form-input" placeholder="Tu contraseña del POS">
          <button class="password-toggle" type="button" onclick="togglePasswordVisibility('google-link-password', this)" aria-label="Mostrar contraseña">👁</button>
        </div>
      </div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="submitGoogleLinkAction()">Vincular y entrar</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('google-link-user')?.focus(), 0);
}

async function submitGoogleLinkAction() {
  if (!pendingGoogleLinkSession?.idToken) {
    showToast('La sesión de Google ya no está disponible. Inténtalo de nuevo.', 'error');
    closeAllModals();
    return;
  }

  const usuario = document.getElementById('google-link-user')?.value?.trim() || '';
  const password = document.getElementById('google-link-password')?.value || '';
  const sessionLanguage = document.getElementById('login-language-select')?.value || setupWizard.language || DB.config?.idioma || 'es';

  if (!usuario || !password) {
    showToast('Escribe tu usuario y contraseña actual para vincular Google.', 'warning');
    return;
  }

  try {
    const response = await api.linkGoogleLogin(pendingGoogleLinkSession.idToken, usuario, password);
    hydrateDB(response.data);
    DB.config.idioma = sessionLanguage;
    setupWizard.language = sessionLanguage;
    DB.currentUser = response.user;
    closeAllModals();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    document.querySelector('.user-name').textContent = DB.currentUser.nombre;
    document.querySelector('.user-role').textContent = DB.currentUser.rol;
    document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0];
    pendingGoogleLinkSession = null;
    initApp();
    showToast('Cuenta Google vinculada correctamente.', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo vincular la cuenta de Google.', 'error');
  }
}

function getAccessMethodsLabel() {
  const methods = [];
  if (DB.currentUser?.googleLinked) {
    methods.push(appText('settings.accessMethodGoogleOnly', 'Google'));
  }
  if (DB.currentUser?.localPasswordSet) {
    methods.push(appText('settings.accessMethodLocalOnly', 'Usuario y contraseña'));
  }
  if (methods.length === 2) {
    return appText('settings.accessMethodBoth', 'Google y usuario/contraseña');
  }
  return methods[0] || appText('settings.accessMethodLocalOnly', 'Usuario y contraseña');
}

function openAccessPasswordModal() {
  if (!DB.currentUser?.id) {
    showToast('Debes iniciar sesión para cambiar tu contraseña de acceso.', 'error');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  const hasExistingPassword = Boolean(DB.currentUser?.localPasswordSet);
  if (!overlay || !title || !body || !footer) return;

  title.textContent = hasExistingPassword
    ? appText('settings.accessPasswordModalChangeTitle', 'Cambiar contraseña de acceso')
    : appText('settings.accessPasswordModalCreateTitle', 'Crear contraseña de acceso');

  body.innerHTML = `
    <div class="modal-grid">
      <div class="form-group span-full">
        <label>${appText('settings.accessMethods', 'Métodos disponibles')}</label>
        <input type="text" class="form-input" value="${getAccessMethodsLabel()}" disabled>
      </div>
      <div class="form-group span-full">
        <p style="color:var(--text2);font-size:0.84rem;line-height:1.5;margin-bottom:0">
          ${hasExistingPassword
            ? appText('settings.accessPasswordModalTextChange', 'Actualiza la contraseña local que usas para entrar con tu usuario.')
            : appText('settings.accessPasswordModalTextCreate', 'Crea una contraseña local para poder entrar también con tu usuario.')}
        </p>
      </div>
      ${hasExistingPassword ? `
        <div class="form-group span-full">
          <label>${appText('settings.accessPasswordCurrent', 'Contraseña actual')}</label>
          <div class="password-field">
            <input type="password" id="access-password-current" class="form-input" placeholder="${appText('settings.accessPasswordCurrentPlaceholder', 'Escribe tu contraseña actual')}">
            <button class="password-toggle" type="button" onclick="togglePasswordVisibility('access-password-current', this)" aria-label="Mostrar contraseña">👁</button>
          </div>
        </div>
      ` : ''}
      <div class="form-group span-full">
        <label>${appText('settings.accessPasswordNew', 'Nueva contraseña')}</label>
        <div class="password-field">
          <input type="password" id="access-password-new" class="form-input" placeholder="${appText('settings.accessPasswordNewPlaceholder', 'Mínimo 4 caracteres')}">
          <button class="password-toggle" type="button" onclick="togglePasswordVisibility('access-password-new', this)" aria-label="Mostrar contraseña">👁</button>
        </div>
      </div>
      <div class="form-group span-full">
        <label>${appText('settings.accessPasswordConfirm', 'Confirmar contraseña')}</label>
        <div class="password-field">
          <input type="password" id="access-password-confirm" class="form-input" placeholder="${appText('settings.accessPasswordConfirmPlaceholder', 'Repite la nueva contraseña')}">
          <button class="password-toggle" type="button" onclick="togglePasswordVisibility('access-password-confirm', this)" aria-label="Mostrar contraseña">👁</button>
        </div>
      </div>
      <div class="form-group span-full">
        <div id="access-password-status" style="color:var(--text2);font-size:0.84rem">
          ${hasExistingPassword
            ? appText('settings.accessPasswordStatusChange', 'Tu acceso local seguirá funcionando con la nueva contraseña.')
            : appText('settings.accessPasswordStatusCreate', 'Todavía no tienes una contraseña local creada.')}
        </div>
      </div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="submitAccessPasswordAction()">${hasExistingPassword
      ? appText('settings.accessPasswordButtonChange', 'Cambiar contraseña')
      : appText('settings.accessPasswordButtonCreate', 'Crear contraseña')}</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById(hasExistingPassword ? 'access-password-current' : 'access-password-new')?.focus(), 0);
}

async function submitAccessPasswordAction() {
  const hasExistingPassword = Boolean(DB.currentUser?.localPasswordSet);
  const currentPassword = document.getElementById('access-password-current')?.value?.trim() || '';
  const newPassword = document.getElementById('access-password-new')?.value?.trim() || '';
  const confirmPassword = document.getElementById('access-password-confirm')?.value?.trim() || '';

  if (hasExistingPassword && !currentPassword) {
    showToast('Escribe tu contraseña actual para continuar.', 'warning');
    return;
  }
  if (newPassword.length < 4) {
    showToast('La nueva contraseña debe tener al menos 4 caracteres.', 'warning');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('La confirmación de la contraseña no coincide.', 'warning');
    return;
  }

  try {
    const updatedUser = await api.changeAccessPassword({
      actorUserId: DB.currentUser.id,
      currentPassword,
      newPassword
    });
    DB.currentUser = { ...DB.currentUser, ...updatedUser };
    closeAllModals();
    syncConfigForm();
    showToast(hasExistingPassword ? 'Contraseña de acceso actualizada.' : 'Contraseña de acceso creada.', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo actualizar la contraseña de acceso.', 'error');
  }
}

function translateDynamicUi(root = document.body) {
  if (typeof window.applyUiTranslation === 'function') window.applyUiTranslation(root);
  if (typeof window.scheduleUiTranslation === 'function') window.scheduleUiTranslation(root);
}

async function exportBackup() {
  try {
    const payload = await api.exportBackup();
    const content = JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `tecnocaja-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast('Copia de seguridad descargada', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function triggerRestoreBackup() {
  if (!isAdministrator()) {
    showToast('Solo el administrador puede restaurar copias de seguridad.', 'warning');
    return;
  }
  const input = document.getElementById('backup-file-input');
  if (input) input.click();
}

async function handleBackupFile(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    if (!isAdministrator()) {
      throw new Error('Solo el administrador puede restaurar copias de seguridad.');
    }
    const content = await file.text();
    const payload = JSON.parse(content);
    if (!confirm('Esto reemplazará la data actual del sistema. ¿Deseas continuar?')) {
      event.target.value = '';
      return;
    }
    await api.restoreBackup({
      payload,
      ...getActorPayload()
    });
    await reloadBootstrapData();
    showToast('Copia restaurada correctamente', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo restaurar la copia', 'error');
  } finally {
    event.target.value = '';
  }
}

async function restoreSecureBackup() {
  openSecureBackupModal('restore');
}

function openSecureBackupFolder() {
  openSecureBackupModal('folder');
}

function openResetSystemModal() {
  if (!isAdministrator()) {
    showToast('Solo el administrador puede limpiar la app.', 'warning');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = 'Eliminar todo';
  body.innerHTML = `
    <div class="form-group">
      <label>Confirmación obligatoria</label>
      <p style="color:var(--danger);font-size:0.84rem;line-height:1.5;margin-bottom:0.75rem">
        Esta acción limpiará la app completa. Si no marcas Firebase, se conservarán la configuración actual y tu usuario administrador para que puedas seguir entrando.
      </p>
      <p style="color:var(--text2);font-size:0.82rem;line-height:1.5;margin-bottom:0.75rem">
        Si también marcas Firebase, Tecno Caja dejará la base local en modo primera instalación para que al reinstalar empiece desde cero. Antes de borrar, Tecno Caja guardará una copia segura automática.
      </p>
      <input type="text" id="reset-system-confirmation" class="form-input" placeholder="Escribe ELIMINAR TODO">
      <div style="height:0.75rem"></div>
      <label>Clave de seguridad</label>
      <div class="password-field">
        <input type="password" id="reset-system-password" class="form-input" placeholder="Ingresa la clave de seguridad">
        <button class="password-toggle" type="button" onclick="togglePasswordVisibility('reset-system-password', this)" aria-label="Mostrar clave">👁</button>
      </div>
      <div style="height:1rem"></div>
      <label style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer">
        <input type="checkbox" id="reset-system-purge-firebase" onchange="toggleResetFirebaseFields()" style="margin-top:0.15rem">
        <span>
          <strong>También borrar Firebase</strong><br>
          <small style="color:var(--text2)">Elimina la licencia, usuarios remotos, reportes, clientes sincronizados y códigos móviles del negocio. Usa esto solo en la terminal principal.</small>
        </span>
      </label>
      <div id="reset-system-firebase-fields" class="hidden" style="margin-top:0.85rem;padding:0.85rem;border:1px solid rgba(239,68,68,0.28);border-radius:12px;background:rgba(239,68,68,0.08)">
        <label>Confirmación remota</label>
        <input type="text" id="reset-system-cloud-confirmation" class="form-input" placeholder="Escribe BORRAR FIREBASE">
        <p style="color:var(--text2);font-size:0.8rem;line-height:1.5;margin-top:0.65rem;margin-bottom:0">
          Después de borrar Firebase, la base local quedará en cero. Luego desinstala Tecno Caja desde Windows y acepta eliminar también los archivos locales de esta PC.
        </p>
      </div>
      <div id="reset-system-status" style="margin-top:0.75rem;color:var(--text2);font-size:0.85rem"></div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="executeResetSystem()" style="background:var(--danger)">Eliminar todo</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('reset-system-confirmation')?.focus(), 0);
}

function toggleResetFirebaseFields() {
  const enabled = Boolean(document.getElementById('reset-system-purge-firebase')?.checked);
  const wrapper = document.getElementById('reset-system-firebase-fields');
  if (wrapper) wrapper.classList.toggle('hidden', !enabled);
}

async function executeResetSystem() {
  const confirmationInput = document.getElementById('reset-system-confirmation');
  const passwordInput = document.getElementById('reset-system-password');
  const purgeFirebase = Boolean(document.getElementById('reset-system-purge-firebase')?.checked);
  const cloudConfirmation = document.getElementById('reset-system-cloud-confirmation')?.value?.trim() || '';
  const status = document.getElementById('reset-system-status');
  const confirmation = confirmationInput?.value?.trim() || '';
  const password = passwordInput?.value?.trim() || '';

  if (confirmation.toUpperCase() !== 'ELIMINAR TODO') {
    if (status) status.textContent = 'Debes escribir exactamente ELIMINAR TODO.';
    showToast('Debes escribir exactamente ELIMINAR TODO.', 'warning');
    return;
  }
  if (!password) {
    if (status) status.textContent = 'Debes ingresar la clave de seguridad.';
    showToast('Debes ingresar la clave de seguridad.', 'warning');
    return;
  }
  if (purgeFirebase && cloudConfirmation.toUpperCase() !== 'BORRAR FIREBASE') {
    if (status) status.textContent = 'Debes escribir exactamente BORRAR FIREBASE para limpiar la nube.';
    showToast('Debes escribir exactamente BORRAR FIREBASE para limpiar la nube.', 'warning');
    return;
  }

  if (status) {
    status.textContent = purgeFirebase
      ? 'Guardando copia segura, borrando Firebase y dejando la base local en estado inicial...'
      : 'Guardando copia segura y limpiando la app...';
  }

  try {
    const response = await api.resetSystem({
      confirmation,
      password,
      purgeFirebase,
      cloudConfirmation,
      ...getActorPayload()
    });
    closeAllModals();
    if (response.firebasePurged) {
      showToast(response.message || 'Firebase borrado correctamente. La base local quedó en cero; ahora desinstala Tecno Caja y elimina los archivos locales de esta PC.', 'success');
      setTimeout(() => window.location.reload(), 900);
      return;
    }
    hydrateDB(response.data);
    if (DB.currentUser) {
      document.querySelector('.user-name').textContent = DB.currentUser.nombre;
      document.querySelector('.user-role').textContent = DB.currentUser.rol;
      document.querySelector('.user-avatar').textContent = DB.currentUser.nombre[0];
    }
    initApp();
    showToast(`App limpiada correctamente. Copia segura: ${response.backupFile}`, 'success');
  } catch (error) {
    if (status) status.textContent = error.message || 'No se pudo limpiar la app.';
    showToast(error.message || 'No se pudo limpiar la app.', 'error');
  }
}

function openSecureBackupModal(action) {
  const isRestore = action === 'restore';
  if (isRestore && !isAdministrator()) {
    showToast('Solo el administrador puede restaurar la copia segura.', 'warning');
    return;
  }

  if (!isRestore && !window.novaDesktop?.openSecureBackupFolder) {
    showToast('Esta función solo está disponible en la app de escritorio.', 'warning');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = isRestore ? 'Restaurar copia segura' : 'Abrir carpeta segura';
  body.innerHTML = `
    <div class="form-group">
      <label>Clave de seguridad</label>
      <div class="password-field">
        <input type="password" id="secure-backup-password" class="form-input" placeholder="Ingresa la clave">
        <button class="password-toggle" type="button" onclick="togglePasswordVisibility('secure-backup-password', this)" aria-label="Mostrar clave">👁</button>
      </div>
      <p style="color:var(--text2);font-size:0.82rem;line-height:1.5;margin-top:0.75rem">
        ${isRestore
          ? 'Se restaurará la última copia automática cifrada y reemplazará la data actual del sistema.'
          : 'Se abrirá la carpeta protegida donde se guarda la última copia automática del sistema.'}
      </p>
      <div id="secure-backup-status" style="margin-top:0.75rem;color:var(--text2);font-size:0.85rem"></div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="submitSecureBackupAction('${action}')">${isRestore ? 'Restaurar ahora' : 'Abrir carpeta'}</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('secure-backup-password')?.focus(), 0);
}

function openSecurityPasswordModal(mode) {
  if (!isAdministrator()) {
    showToast('Solo el administrador puede gestionar la clave de seguridad.', 'warning');
    return;
  }

  const isReset = mode === 'reset';
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = isReset ? 'Restablecer clave de seguridad' : 'Cambiar clave de seguridad';
  body.innerHTML = `
    <div class="modal-grid">
      ${isReset ? `
        <div class="form-group span-full">
          <label>Confirmación</label>
          <input type="text" id="security-password-confirmation" class="form-input" placeholder="Escribe RESTABLECER">
          <p style="color:var(--text2);font-size:0.82rem;line-height:1.5;margin-top:0.75rem">
            La clave volverá al valor de fábrica: ${'Seguridad2026'}.
          </p>
        </div>
      ` : `
        <div class="form-group span-full">
          <label>Clave actual</label>
          <div class="password-field">
            <input type="password" id="security-password-current" class="form-input" placeholder="Ingresa la clave actual">
            <button class="password-toggle" type="button" onclick="togglePasswordVisibility('security-password-current', this)" aria-label="Mostrar clave">👁</button>
          </div>
        </div>
        <div class="form-group">
          <label>Nueva clave</label>
          <div class="password-field">
            <input type="password" id="security-password-new" class="form-input" placeholder="Nueva clave">
            <button class="password-toggle" type="button" onclick="togglePasswordVisibility('security-password-new', this)" aria-label="Mostrar clave">👁</button>
          </div>
        </div>
        <div class="form-group">
          <label>Confirmar nueva clave</label>
          <div class="password-field">
            <input type="password" id="security-password-confirm" class="form-input" placeholder="Confirma la nueva clave">
            <button class="password-toggle" type="button" onclick="togglePasswordVisibility('security-password-confirm', this)" aria-label="Mostrar clave">👁</button>
          </div>
        </div>
      `}
      <div id="security-password-status" class="span-full" style="color:var(--text2);font-size:0.85rem"></div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" onclick="submitSecurityPasswordAction('${mode}')">${isReset ? 'Restablecer' : 'Guardar clave'}</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
}

async function submitSecurityPasswordAction(mode) {
  const status = document.getElementById('security-password-status');
  const isReset = mode === 'reset';

  try {
    if (isReset) {
      const confirmation = document.getElementById('security-password-confirmation')?.value?.trim().toUpperCase() || '';
      if (confirmation !== 'RESTABLECER') {
        throw new Error('Debes escribir RESTABLECER para continuar.');
      }
      if (status) status.textContent = 'Restableciendo clave de seguridad...';
      const response = await api.resetSecurityPassword(getActorPayload());
      closeAllModals();
      showToast(`Clave restablecida a ${response.defaultPassword}`, 'success');
      return;
    }

    const currentPassword = document.getElementById('security-password-current')?.value?.trim() || '';
    const newPassword = document.getElementById('security-password-new')?.value?.trim() || '';
    const confirmPassword = document.getElementById('security-password-confirm')?.value?.trim() || '';
    if (!currentPassword || !newPassword || !confirmPassword) {
      throw new Error('Completa todos los campos de la clave de seguridad.');
    }
    if (newPassword !== confirmPassword) {
      throw new Error('La nueva clave y su confirmación no coinciden.');
    }
    if (status) status.textContent = 'Actualizando clave de seguridad...';
    await api.changeSecurityPassword({
      currentPassword,
      newPassword,
      ...getActorPayload()
    });
    closeAllModals();
    showToast('Clave de seguridad actualizada correctamente', 'success');
  } catch (error) {
    if (status) status.textContent = error.message || 'No se pudo actualizar la clave.';
    showToast(error.message || 'No se pudo actualizar la clave.', 'error');
  }
}

async function submitSecureBackupAction(action) {
  const passwordInput = document.getElementById('secure-backup-password');
  const status = document.getElementById('secure-backup-status');
  const password = passwordInput?.value?.trim() || '';
  const isRestore = action === 'restore';

  if (!password) {
    if (status) status.textContent = 'Debes ingresar la clave de seguridad.';
    showToast('Debes ingresar la clave de seguridad.', 'warning');
    return;
  }

  if (status) status.textContent = isRestore ? 'Restaurando copia segura...' : 'Abriendo carpeta segura...';

  try {
    if (isRestore) {
      await api.restoreLatestSecureBackup({
        password,
        ...getActorPayload()
      });
      await reloadBootstrapData();
      closeAllModals();
      showToast('Copia segura restaurada correctamente', 'success');
      return;
    }

    const response = await window.novaDesktop.openSecureBackupFolder(password);
    if (!response?.ok) throw new Error(response?.error || 'No se pudo abrir la carpeta segura.');
    closeAllModals();
    showToast('Carpeta segura abierta', 'success');
  } catch (error) {
    if (status) status.textContent = error.message || 'No se pudo completar la acción.';
    showToast(error.message || 'No se pudo completar la acción.', 'error');
  }
}

async function legacyRestoreSecureBackupHandler() {
  if (!isAdministrator()) {
    showToast('Solo el administrador puede restaurar la copia segura.', 'warning');
    return;
  }

  const password = prompt('Ingresa la clave de seguridad para restaurar la copia segura:');
  if (password === null) return;
  if (!password.trim()) {
    showToast('Debes ingresar la clave de seguridad.', 'warning');
    return;
  }
  if (!confirm('Esto reemplazará la data actual por la última copia segura automática. ¿Deseas continuar?')) {
    return;
  }

  try {
    await api.restoreLatestSecureBackup({
      password: password.trim(),
      ...getActorPayload()
    });
    await reloadBootstrapData();
    showToast('Copia segura restaurada correctamente', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo restaurar la copia segura', 'error');
  }
}

async function legacyOpenSecureBackupFolderHandler() {
  if (!window.novaDesktop?.openSecureBackupFolder) {
    showToast('Esta función solo está disponible en la app de escritorio.', 'warning');
    return;
  }

  const password = prompt('Ingresa la clave de seguridad para abrir la carpeta protegida:');
  if (password === null) return;
  if (!password.trim()) {
    showToast('Debes ingresar la clave de seguridad.', 'warning');
    return;
  }

  try {
    const response = await window.novaDesktop.openSecureBackupFolder(password.trim());
    if (!response?.ok) throw new Error(response?.error || 'No se pudo abrir la carpeta segura.');
    showToast('Carpeta segura abierta', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo abrir la carpeta segura', 'error');
  }
}

window.toggleTheme = toggleTheme;
window.setTheme = setTheme;
window.setAccent = setAccent;
window.exportBackup = exportBackup;
window.restoreSecureBackup = restoreSecureBackup;
window.openSecureBackupFolder = openSecureBackupFolder;
window.submitSecureBackupAction = submitSecureBackupAction;
window.openGoogleLinkModal = openGoogleLinkModal;
window.submitGoogleLinkAction = submitGoogleLinkAction;
window.openAccessPasswordModal = openAccessPasswordModal;
window.submitAccessPasswordAction = submitAccessPasswordAction;
window.openSecurityPasswordModal = openSecurityPasswordModal;
window.submitSecurityPasswordAction = submitSecurityPasswordAction;
window.triggerLogoUpload = triggerLogoUpload;
window.handleLogoUpload = handleLogoUpload;
window.clearLogoSelection = clearLogoSelection;
window.togglePasswordVisibility = togglePasswordVisibility;
window.applyBranding = applyBranding;
window.changeStartupLanguage = changeStartupLanguage;
window.translateCatalogText = translateCatalogText;
window.handleLoginNewClick = handleLoginNewClick;
window.startLongPressTimer = startLongPressTimer;
window.clearLongPressTimer = clearLongPressTimer;
window.executeFactoryReset = executeFactoryReset;
window.getLocalizedProductName = getLocalizedProductName;
window.getLocalizedCategoryName = getLocalizedCategoryName;
window.setLoginMode = setLoginMode;
window.startNewUserFlow = startNewUserFlow;
window.launchSetupWizardFromLogin = launchSetupWizardFromLogin;
window.confirmSetupReinstallModal = confirmSetupReinstallModal;
window.refreshStartupStatus = refreshStartupStatus;
window.openLicenseWhatsAppSupport = openLicenseWhatsAppSupport;
window.openWhatsAppWeb = openWhatsAppWeb;
window.handleWhatsAppWebToggle = handleWhatsAppWebToggle;
window.goToSetupStep = goToSetupStep;
window.completeInitialSetup = completeInitialSetup;
window.submitCashGate = submitCashGate;
window.openResetSystemModal = openResetSystemModal;
window.submitFactoryResetModal = submitFactoryResetModal;
window.executeResetSystem = executeResetSystem;
window.applyUiPreferences = applyUiPreferences;
window.settleDeliveryCash = settleDeliveryCash;
// ═══════════════════════════════════════════════════════════════════
// ACCESOS RÁPIDOS DE CAJA
// ═══════════════════════════════════════════════════════════════════

/** Navega al módulo de ventas y ejecuta una acción específica. */
function goToVentasAction(action) {
  const nav = document.querySelector('.nav-item[data-module="ventas"]');
  if (nav) showModule('ventas', nav);
  setTimeout(() => {
    if (action === 'suspend' && typeof suspendSale === 'function') suspendSale();
    if (action === 'cotizar' && typeof openQuotationModal === 'function') openQuotationModal();
  }, 150);
}

// ─── GAVETA: Abrir sin venta ──────────────────────────────────────

let _gavetaMotivoSelected = '';

function openGavetaModal() {
  if (!DB.config.cajaAbierta) {
    showToast('La caja debe estar abierta para usar la gaveta.', 'warning');
    return;
  }
  _gavetaMotivoSelected = '';
  document.querySelectorAll('.gaveta-motivo-btn').forEach(b => b.classList.remove('selected'));
  const otroWrap = document.getElementById('gaveta-otro-wrap');
  if (otroWrap) otroWrap.classList.add('hidden');
  const otroInput = document.getElementById('gaveta-otro-input');
  if (otroInput) otroInput.value = '';
  const confirmBtn = document.getElementById('btn-gaveta-confirm');
  if (confirmBtn) confirmBtn.disabled = true;
  document.getElementById('gaveta-modal')?.classList.remove('hidden');
}

function closeGavetaModal() {
  document.getElementById('gaveta-modal')?.classList.add('hidden');
}

function selectGavetaMotivo(btn) {
  document.querySelectorAll('.gaveta-motivo-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  _gavetaMotivoSelected = btn.dataset.motivo || '';
  const otroWrap = document.getElementById('gaveta-otro-wrap');
  if (otroWrap) otroWrap.classList.toggle('hidden', _gavetaMotivoSelected !== 'Otro');
  const confirmBtn = document.getElementById('btn-gaveta-confirm');
  if (confirmBtn) confirmBtn.disabled = false;
}

async function submitGavetaOpen() {
  let motivo = _gavetaMotivoSelected;
  if (motivo === 'Otro') {
    const custom = document.getElementById('gaveta-otro-input')?.value?.trim();
    if (!custom) { showToast('Especifique el motivo.', 'warning'); return; }
    motivo = custom;
  }
  if (!motivo) { showToast('Seleccione un motivo.', 'warning'); return; }

  const confirmBtn = document.getElementById('btn-gaveta-confirm');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Abriendo...'; }

  try {
    // Abrir gaveta física
    if (window.novaDesktop?.openCashDrawer && DB.config.cashDrawerEnabled) {
      const cfg = {
        method:      DB.config.cashDrawerMethod      || 'escpos',
        printerName: DB.config.cashDrawerPrinterName || DB.config.receiptPrinterName || '',
        pin:         Number(DB.config.cashDrawerPin  ?? 0),
        networkHost: DB.config.cashDrawerNetworkHost || '',
        networkPort: Number(DB.config.cashDrawerNetworkPort || 9100),
        serialPort:  DB.config.cashDrawerSerialPort  || 'COM1',
      };
      window.novaDesktop.openCashDrawer(cfg).catch(err =>
        console.warn('[gaveta] No se pudo abrir físicamente:', err?.message)
      );
    }

    // Registrar en servidor
    await api.cashDrawerEvent({
      motivo,
      ...getBusinessStructurePayload(),
      ...getActorPayload()
    });

    // Registrar en movimientos locales para display
    DB.movimientosCaja.unshift({
      tipo: 'Gaveta abierta',
      monto: 0,
      hora: new Date().toLocaleString('es-DO'),
      obs: `Apertura manual — Motivo: ${motivo}`,
      usuarioId: DB.currentUser?.id || null,
      usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema'
    });
    renderMovimientosCaja();

    closeGavetaModal();
    showToast(`Gaveta abierta — Motivo: ${motivo}`, 'success');
  } catch (err) {
    showToast(err.message || 'Error al registrar apertura de gaveta.', 'error');
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '💵 Abrir Gaveta'; }
  }
}

// ─── CORTE DE CAJA ────────────────────────────────────────────────

function _getCorteData() {
  const todayKey = getDateKeyFromValue(new Date());

  // Hora apertura — buscar el último movimiento de tipo 'Apertura'
  const aperturaMov = (DB.movimientosCaja || []).find(m => m.tipo === 'Apertura');
  const horaApertura = aperturaMov
    ? new Date(aperturaMov.hora).toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
    : '—';

  // Ventas de hoy
  const ventasHoy = (DB.ventas || []).filter(s => {
    if (s.cancelada) return false;
    const fecha = s.cobradaEn || s.fecha;
    return getDateKeyFromValue(fecha) === todayKey && String(s.estadoVenta || 'pagada') === 'pagada';
  });

  let efectivo = 0, tarjeta = 0, transferencia = 0, credito = 0, descuentos = 0;
  for (const s of ventasHoy) {
    const mth = String(s.metodo || '').trim();
    const total = Number(s.total || 0);
    descuentos += Number(s.descuento || 0);
    if (mth === 'efectivo' || mth === 'contra_entrega') efectivo += total;
    else if (mth === 'tarjeta') tarjeta += total;
    else if (mth === 'transferencia') transferencia += total;
    else if (mth === 'credito') credito += total;
    else if (mth === 'mixto') {
      // Para mixto, distribuir según los campos
      efectivo    += Number(s.mixedCashAmount    || 0);
      tarjeta     += Number(s.mixedCardAmount    || 0);
      transferencia += Number(s.mixedTransferAmount || 0);
    }
  }

  // Movimientos de caja de hoy
  let entradas = 0, salidas = 0, devoluciones = 0;
  for (const mov of DB.movimientosCaja || []) {
    const monto = Number(mov.monto || 0);
    const movDay = getDateKeyFromValue(mov.hora);
    if (movDay !== todayKey) continue;
    if (monto === 0) continue; // gaveta eventos
    if (mov.tipo === 'Ingreso adicional') entradas += monto;
    else if (mov.tipo === 'Devolución' && monto < 0) devoluciones += Math.abs(monto);
    else if (monto < 0) salidas += Math.abs(monto);
  }

  // Total esperado en la gaveta
  const montoApertura = Number(DB.config.cajaMonto || 0);
  const totalEsperado = Math.max(0, montoApertura);

  return {
    cajero: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Cajero',
    horaApertura,
    horaCorte: new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }),
    ventasCount: ventasHoy.length,
    efectivo, tarjeta, transferencia, credito,
    descuentos, devoluciones, entradas, salidas,
    totalEsperado,
  };
}

function openCashCorteModal() {
  const d = _getCorteData();
  document.getElementById('corte-cajero').textContent       = d.cajero;
  document.getElementById('corte-hora-apertura').textContent = d.horaApertura;
  document.getElementById('corte-hora-actual').textContent   = d.horaCorte;
  document.getElementById('corte-ventas-count').textContent  = d.ventasCount;
  document.getElementById('corte-efectivo').textContent      = fmt(d.efectivo);
  document.getElementById('corte-tarjeta').textContent       = fmt(d.tarjeta);
  document.getElementById('corte-transferencia').textContent = fmt(d.transferencia);
  document.getElementById('corte-credito').textContent       = fmt(d.credito);
  document.getElementById('corte-descuentos').textContent    = `- ${fmt(d.descuentos)}`;
  document.getElementById('corte-devoluciones').textContent  = `- ${fmt(d.devoluciones)}`;
  document.getElementById('corte-entradas').textContent      = fmt(d.entradas);
  document.getElementById('corte-salidas').textContent       = `- ${fmt(d.salidas)}`;
  document.getElementById('corte-total-esperado').textContent = fmt(d.totalEsperado);
  const contado = document.getElementById('corte-contado');
  if (contado) contado.value = '';
  document.getElementById('corte-diff-wrap')?.classList.add('hidden');
  document.getElementById('corte-notas').value = '';
  document.getElementById('cash-corte-modal')?.classList.remove('hidden');
}

function closeCashCorteModal() {
  document.getElementById('cash-corte-modal')?.classList.add('hidden');
}

function calcCorteDiff() {
  const totalEsperadoEl = document.getElementById('corte-total-esperado');
  const contadoEl = document.getElementById('corte-contado');
  const diffWrap = document.getElementById('corte-diff-wrap');
  const diffText = document.getElementById('corte-diff-text');
  const diffIcon = document.getElementById('corte-diff-icon');

  const esperado = parseFmtMoney(totalEsperadoEl?.textContent || '0');
  const contado  = parseFloat(contadoEl?.value || 0) || 0;
  const diff     = contado - esperado;

  if (!contadoEl?.value || diffWrap === null) return;

  diffWrap.classList.remove('hidden', 'corte-diff-ok', 'corte-diff-over', 'corte-diff-under');

  if (Math.abs(diff) < 0.01) {
    diffWrap.classList.add('corte-diff-ok');
    diffIcon.textContent = '✅';
    diffText.textContent = 'Sin diferencia — caja cuadrada';
  } else if (diff > 0) {
    diffWrap.classList.add('corte-diff-over');
    diffIcon.textContent = '⚠';
    diffText.textContent = `Sobran ${fmt(diff)}`;
  } else {
    diffWrap.classList.add('corte-diff-under');
    diffIcon.textContent = '⚠';
    diffText.textContent = `Faltan ${fmt(Math.abs(diff))}`;
  }
}

/** Parsea un texto de moneda como "RD$ 1,234.56" → número. */
function parseFmtMoney(text) {
  return parseFloat(String(text || '').replace(/[^0-9.-]/g, '')) || 0;
}

async function saveCashCorte({ print = false } = {}) {
  const d = _getCorteData();
  const contado    = parseFloat(document.getElementById('corte-contado')?.value || 0) || 0;
  const notas      = document.getElementById('corte-notas')?.value?.trim() || '';
  const diferencia = contado - d.totalEsperado;

  // Deshabilitar botones para evitar doble envío
  const footerBtns = document.querySelectorAll('#cash-corte-modal .modal-card-footer button');
  footerBtns.forEach(b => { b.disabled = true; });

  try {
    // 1. Guardar el registro de corte
    await api.cashCorte({
      cajero:        d.cajero,
      horaApertura:  d.horaApertura,
      horaCorte:     d.horaCorte,
      ventas:        d.ventasCount,
      efectivo:      d.efectivo,
      tarjeta:       d.tarjeta,
      transferencia: d.transferencia,
      credito:       d.credito,
      descuentos:    d.descuentos,
      devoluciones:  d.devoluciones,
      entradas:      d.entradas,
      salidas:       d.salidas,
      totalEsperado: d.totalEsperado,
      contadoFisico: contado,
      diferencia,
      notas,
      ...getBusinessStructurePayload(),
      ...getActorPayload()
    });

    // 2. Cerrar la sesión de caja automáticamente (sin pedir confirmación)
    if (cajaAbierta) {
      try {
        const montoFinal = contado || DB.config.cajaMonto || 0;
        const response = await api.closeCash({
          monto: montoFinal,
          obs:   notas || 'Cierre por corte de caja',
          ...getBusinessStructurePayload(),
          ...getActorPayload()
        });
        DB.config = { ...DB.config, ...response.config };
        DB.caja   = { ...DB.caja, sessionId: null, abierta: false };
        cajaAbierta = false;
        DB.movimientosCaja.unshift({
          tipo:          'Cierre',
          monto:         montoFinal,
          hora:          new Date().toLocaleString('es-DO'),
          obs:           notas || 'Cierre por corte de caja',
          usuarioId:     DB.currentUser?.id || null,
          usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema'
        });
        syncCajaState();
        refreshAuditLogs();
        updateNotifications();
      } catch (closeErr) {
        console.warn('[corte] Error al cerrar sesión de caja:', closeErr);
        showToast('Corte guardado, pero no se pudo cerrar la sesión de caja.', 'warning');
      }
    }

    // 3. Imprimir si se solicitó (primero cerrar modal, luego imprimir)
    closeCashCorteModal();
    showToast('✅ Corte guardado. Caja cerrada. Redirigiendo...', 'success');
    if (print) _printCashCorte(d, contado, diferencia, notas).catch((err) => {
      console.warn('[corte] Error imprimiendo corte:', err);
      showToast('No se pudo imprimir el corte. Revisa la impresora.', 'error');
    });

    // 4. Redirigir al inicio de sesión
    setTimeout(() => doLogout(), 1800);

  } catch (err) {
    showToast(err.message || 'Error al guardar el corte.', 'error');
    // Re-habilitar botones si hubo error
    footerBtns.forEach(b => { b.disabled = false; });
  }
}

async function saveCashCorteAndClose() {
  // Mantener por compatibilidad — ahora saveCashCorte ya cierra la caja
  await saveCashCorte({ print: false });
}

async function _printCashCorte(d, contado, diferencia, notas) {
  const printerName  = String(DB.config?.receiptPrinterName || '').trim();
  const paperWidth   = String(DB.config?.receiptPaperSize   || '80mm').toLowerCase();
  const currency     = DB.config?.currency || 'RD$';
  const isThermal    = paperWidth === '58mm' || paperWidth === '80mm';
  const canEscpos    = Boolean(window.novaDesktop?.printCorteEscpos && isThermal && printerName);

  // ── Ruta 1: ESC/POS directo a impresora térmica (app de escritorio) ──────
  if (canEscpos) {
    const cortePayload = {
      negocio: {
        nombre:    DB.config?.businessName  || 'Tecno Caja',
        rnc:       DB.config?.rnc           || '',
      },
      corte: {
        cajero:        d.cajero,
        horaApertura:  d.horaApertura,
        horaCorte:     d.horaCorte,
        ventasCount:   d.ventasCount,
        efectivo:      d.efectivo,
        tarjeta:       d.tarjeta,
        transferencia: d.transferencia,
        credito:       d.credito,
        descuentos:    d.descuentos,
        devoluciones:  d.devoluciones,
        entradas:      d.entradas,
        salidas:       d.salidas,
        totalEsperado: d.totalEsperado,
        contado,
        diferencia,
        notas,
      },
      config: {
        paperWidth,
        cortarPapel: true,
        currency,
      },
    };

    try {
      const result = await window.novaDesktop.printCorteEscpos(cortePayload, { printerName, paperWidth });
      if (result?.ok) {
        showToast('Corte enviado a la impresora.', 'success');
        return;
      }
      console.warn('[corte] ESC/POS falló, usando impresión HTML:', result?.error);
      showToast(result?.error || 'No se pudo imprimir el corte. Revisa la impresora.', 'error');
      return;
    } catch (err) {
      console.warn('[corte] Error ESC/POS:', err?.message);
    }
  }

  // ── Ruta 2: HTML + ventana del sistema (sin impresora configurada o web) ──
  const fmtN = (n) => `${currency} ${Number(n || 0).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const diffLine = Math.abs(diferencia) < 0.01
    ? '✅ Sin diferencia'
    : (diferencia > 0 ? `⚠ Sobran ${fmtN(diferencia)}` : `⚠ Faltan ${fmtN(Math.abs(diferencia))}`);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Corte de Caja</title>
  <style>
    body{font-family:'Courier New',monospace;font-size:12px;margin:0;padding:12px;color:#000;background:#fff}
    h2{text-align:center;font-size:14px;margin:0 0 4px}
    .center{text-align:center}
    .sep{border-top:1px dashed #000;margin:6px 0}
    .row{display:flex;justify-content:space-between;margin:2px 0}
    .row.bold{font-weight:bold}
    .diff{text-align:center;font-size:13px;font-weight:bold;margin:6px 0}
    .small{font-size:10px;color:#555}
    @media print{body{padding:4px}}
  </style></head><body>
  <h2>${DB.config?.businessName || 'Tecno Caja'}</h2>
  <p class="center small">CORTE DE CAJA</p>
  <div class="sep"></div>
  <div class="row"><span>Cajero:</span><span>${d.cajero}</span></div>
  <div class="row"><span>Apertura:</span><span>${d.horaApertura}</span></div>
  <div class="row"><span>Corte:</span><span>${d.horaCorte}</span></div>
  <div class="row"><span>Ventas:</span><span>${d.ventasCount}</span></div>
  <div class="sep"></div>
  <div class="row"><span>Efectivo:</span><span>${fmtN(d.efectivo)}</span></div>
  <div class="row"><span>Tarjeta:</span><span>${fmtN(d.tarjeta)}</span></div>
  <div class="row"><span>Transferencia:</span><span>${fmtN(d.transferencia)}</span></div>
  <div class="row"><span>Crédito:</span><span>${fmtN(d.credito)}</span></div>
  <div class="row"><span>Descuentos:</span><span>- ${fmtN(d.descuentos)}</span></div>
  <div class="row"><span>Devoluciones:</span><span>- ${fmtN(d.devoluciones)}</span></div>
  <div class="sep"></div>
  <div class="row"><span>Entradas:</span><span>+ ${fmtN(d.entradas)}</span></div>
  <div class="row"><span>Salidas:</span><span>- ${fmtN(d.salidas)}</span></div>
  <div class="sep"></div>
  <div class="row bold"><span>Total esperado:</span><span>${fmtN(d.totalEsperado)}</span></div>
  <div class="row bold"><span>Contado físico:</span><span>${fmtN(contado)}</span></div>
  <div class="diff">${diffLine}</div>
  ${notas ? `<div class="sep"></div><p class="small">Notas: ${notas}</p>` : ''}
  <div class="sep"></div>
  <p class="center small">${new Date().toLocaleString('es-DO')}</p>
  <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),800)}<\/script>
  </body></html>`;

  const win = window.open('', '_blank', 'width=320,height=600');
  if (win) { win.document.write(html); win.document.close(); }
}

window.openCashExpenseModal = openCashExpenseModal;
window.syncCashExpenseFields = syncCashExpenseFields;
window.saveCashExpense = saveCashExpense;
window.openCashIncomeModal = openCashIncomeModal;
window.saveCashIncome = saveCashIncome;
// Accesos rápidos de caja
window.openGavetaModal       = openGavetaModal;
window.closeGavetaModal      = closeGavetaModal;
window.selectGavetaMotivo    = selectGavetaMotivo;
window.submitGavetaOpen      = submitGavetaOpen;
window.openCashCorteModal    = openCashCorteModal;
window.closeCashCorteModal   = closeCashCorteModal;
window.calcCorteDiff         = calcCorteDiff;
window.saveCashCorte         = saveCashCorte;
window.saveCashCorteAndClose = saveCashCorteAndClose;
window.goToVentasAction      = goToVentasAction;
initializeStartupFlow();

async function refreshCajaFromServer() {
  try {
    const freshData = await api.getBootstrap();
    if (freshData?.config) {
      DB.config = { ...DB.config, ...freshData.config };
    }
    if (freshData?.caja) {
      DB.caja = { ...DB.caja, ...freshData.caja };
    }
    syncCajaState();
  } catch (_) { syncCajaState(); }
}

function syncCajaState() {
  const btn = document.getElementById('btn-caja-action');
  const statusText = document.getElementById('caja-status-text');
  const cajaMontoEl = document.getElementById('caja-monto');
  const actionHint = document.getElementById('caja-action-hint');
  const identity = document.getElementById('caja-identity');
  cajaAbierta = Boolean(DB.config?.cajaAbierta || DB.caja?.abierta);
  DB.config.cajaAbierta = cajaAbierta;
  DB.caja = { ...DB.caja, abierta: cajaAbierta };

  statusText.textContent = cajaAbierta ? appText('cash.open', 'Caja Abierta') : appText('cash.closed', 'Caja Cerrada');
  if (identity) {
    identity.textContent = `${DB.config?.activeBranchName || 'Sin sucursal'} · ${DB.config?.activeCashRegisterName || 'Sin caja'}`;
  }
  cajaMontoEl.textContent = fmt(DB.config.cajaMonto);
  btn.textContent = cajaAbierta ? appText('cash.closeAction', 'Cerrar Caja') : appText('cash.openAction', 'Abrir Caja');
  btn.style.background = cajaAbierta ? 'var(--danger)' : '';
  document.getElementById('caja-status-card').style.borderColor = cajaAbierta ? 'var(--success)' : '';
  if (actionHint) {
    actionHint.textContent = cajaAbierta
      ? appText('cash.closeHint', 'Registra el monto final y una observación antes de cerrar.')
      : appText('cash.openHint', 'Indica el monto inicial y deja una nota para la apertura.');
  }
  syncCashStartupGate();
  renderCajaExpenseSummary();
  renderCajaIncomeSummary();
  renderCajaDaySummary();
  renderMovimientosCaja();
  renderPendingDeliveryCash();
  applyAppTranslations();
  syncColaCobróNav();
}

async function toggleCaja() {
  const inputMonto = document.getElementById('caja-input-monto');
  if (!cajaAbierta) {
    const monto = parseFloat(inputMonto.value) || 0;
    try {
      const response = await api.openCash({
        monto,
        obs: document.getElementById('caja-obs').value || 'Apertura de caja',
        ...getBusinessStructurePayload(),
        ...getActorPayload()
      });
      DB.config = { ...DB.config, ...response.config };
      DB.caja = { ...DB.caja, sessionId: response.sessionId, abierta: true };
      DB.movimientosCaja.unshift({
        tipo: 'Apertura',
        monto,
        hora: new Date().toLocaleString('es-DO'),
        obs: document.getElementById('caja-obs').value || 'Apertura de caja',
        usuarioId: DB.currentUser?.id || null,
        usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema'
      });
      syncCajaState();
      refreshAuditLogs();
      updateNotifications();
      showToast('Caja abierta con ' + fmt(monto), 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  } else {
    if (!window.confirm('¿Deseas cerrar la caja ahora?')) return;
    try {
      const monto = parseFloat(inputMonto.value) || DB.config.cajaMonto || 0;
      const response = await api.closeCash({
        monto,
        obs: document.getElementById('caja-obs').value || 'Cierre de caja',
        ...getBusinessStructurePayload(),
        ...getActorPayload()
      });
      DB.config = { ...DB.config, ...response.config };
      DB.caja = { ...DB.caja, sessionId: null, abierta: false };
      DB.movimientosCaja.unshift({
        tipo: 'Cierre',
        monto,
        hora: new Date().toLocaleString('es-DO'),
        obs: document.getElementById('caja-obs').value || 'Cierre de caja',
        usuarioId: DB.currentUser?.id || null,
        usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema'
      });
      syncCajaState();
      refreshAuditLogs();
      updateNotifications();
      showToast('Caja cerrada exitosamente', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
}

function renderMovimientosCaja() {
  const box = document.getElementById('movimientos-tbody');
  if (!box) return;
  if (!DB.movimientosCaja.length) {
    box.innerHTML = `<p class="text-muted">${appText('cash.noMovements', 'No hay movimientos registrados')}</p>`;
    return;
  }
  box.innerHTML = DB.movimientosCaja.map((mov) => `
    <div class="cash-movement-item ${Number(mov.monto || 0) < 0 ? 'cash-movement-item-out' : 'cash-movement-item-in'}">
      <div class="cash-movement-main">
        <div class="cash-movement-title-row">
          <div class="cash-movement-title">${mov.tipo}</div>
          <span class="cash-movement-chip ${Number(mov.monto || 0) < 0 ? 'cash-movement-chip-out' : 'cash-movement-chip-in'}">
            ${Number(mov.monto || 0) < 0 ? 'Salida' : 'Entrada'}
          </span>
        </div>
        <div class="cash-movement-meta">${mov.usuarioNombre || 'Sistema'} · ${formatCashMovementDate(mov.hora)}</div>
        <div class="cash-movement-notes">${mov.obs || 'Sin observaciones'}</div>
      </div>
      <div class="cash-movement-amount ${Number(mov.monto || 0) < 0 ? 'cash-movement-amount-out' : 'cash-movement-amount-in'}">${fmt(mov.monto)}</div>
    </div>
  `).join('');
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function getDateKeyFromValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : formatDateKey(value);
  }
  if (typeof value === 'number') {
    return getDateKeyFromValue(new Date(value));
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    const explicitDate = new Date(raw);
    if (!Number.isNaN(explicitDate.getTime())) return formatDateKey(explicitDate);
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const localeMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (localeMatch) {
    const [, day, month, year] = localeMatch;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(raw.replace(' ', 'T'));
  if (!Number.isNaN(parsed.getTime())) return formatDateKey(parsed);

  return '';
}

function getCajaExpenseBreakdown() {
  const labels = {
    Gasto: 'gasto',
    'Pago suplidor': 'pago_suplidor',
    'Devolución': 'devolucion',
    'Retiro de efectivo': 'retiro_efectivo'
  };
  const totals = {
    gasto: 0,
    pago_suplidor: 0,
    devolucion: 0,
    retiro_efectivo: 0
  };
  const todayKey = getDateKeyFromValue(new Date());
  for (const mov of DB.movimientosCaja || []) {
    const amount = Number(mov.monto || 0);
    const typeKey = labels[mov.tipo];
    if (!typeKey || amount >= 0) continue;
    const movementDay = getDateKeyFromValue(mov.hora);
    if (movementDay !== todayKey) continue;
    totals[typeKey] += Math.abs(amount);
  }
  return totals;
}

function renderCajaExpenseSummary() {
  const totals = getCajaExpenseBreakdown();
  const total = Object.values(totals).reduce((sum, value) => sum + Number(value || 0), 0);
  const totalEl = document.getElementById('caja-egresos-total');
  const gastoEl = document.getElementById('caja-egreso-gasto');
  const suplidorEl = document.getElementById('caja-egreso-suplidor');
  const devolucionEl = document.getElementById('caja-egreso-devolucion');
  const retiroEl = document.getElementById('caja-egreso-retiro');
  if (totalEl) totalEl.textContent = fmt(total);
  if (gastoEl) gastoEl.textContent = fmt(totals.gasto);
  if (suplidorEl) suplidorEl.textContent = fmt(totals.pago_suplidor);
  if (devolucionEl) devolucionEl.textContent = fmt(totals.devolucion);
  if (retiroEl) retiroEl.textContent = fmt(totals.retiro_efectivo);
}

function getCajaIncomeBreakdown() {
  const totals = {
    ingreso_adicional: 0
  };
  const todayKey = getDateKeyFromValue(new Date());
  for (const mov of DB.movimientosCaja || []) {
    const amount = Number(mov.monto || 0);
    if (amount <= 0 || mov.tipo !== 'Ingreso adicional') continue;
    const movementDay = getDateKeyFromValue(mov.hora);
    if (movementDay !== todayKey) continue;
    totals.ingreso_adicional += amount;
  }
  return totals;
}

function renderCajaIncomeSummary() {
  const totals = getCajaIncomeBreakdown();
  const total = totals.ingreso_adicional;
  const totalEl = document.getElementById('caja-ingresos-total');
  const extraEl = document.getElementById('caja-ingreso-extra');
  if (totalEl) totalEl.textContent = fmt(total);
  if (extraEl) extraEl.textContent = `${fmt(total)} hoy`;
}

function getCajaDaySalesSummary() {
  const totals = {
    efectivo: 0,
    tarjeta: 0,
    transferencia: 0
  };
  const todayKey = getDateKeyFromValue(new Date());

  for (const sale of DB.ventas || []) {
    if (!sale || sale.cancelada) continue;

    let method = String(sale.metodo || '').trim();
    let saleDate = sale.cobradaEn || sale.fecha;
    const saleStatus = String(sale.estadoVenta || 'pagada').trim();

    if (method === 'contra_entrega') {
      if (String(sale.estadoCobroDelivery || 'pendiente').trim() !== 'validado') continue;
      method = 'efectivo';
      saleDate = sale.cobroDeliveryValidadoEn || sale.cobradaEn || sale.fecha;
    } else if (saleStatus !== 'pagada') {
      continue;
    }

    if (!['efectivo', 'tarjeta', 'transferencia'].includes(method)) continue;
    if (getDateKeyFromValue(saleDate) !== todayKey) continue;

    totals[method] += Number(sale.total || 0);
  }

  return totals;
}

function renderCajaDaySummary() {
  const salesTotals = getCajaDaySalesSummary();
  const expenseTotals = getCajaExpenseBreakdown();
  const incomeTotals = getCajaIncomeBreakdown();
  const totalVentas = salesTotals.efectivo + salesTotals.tarjeta + salesTotals.transferencia;
  const totalGastos = Object.values(expenseTotals).reduce((sum, value) => sum + Number(value || 0), 0);
  const balance = totalVentas + Number(incomeTotals.ingreso_adicional || 0) - totalGastos;

  const efectivoEl = document.getElementById('res-efectivo');
  const tarjetaEl = document.getElementById('res-tarjeta');
  const transferEl = document.getElementById('res-transfer');
  const totalEl = document.getElementById('res-total');
  const gastosEl = document.getElementById('res-gastos');
  const balanceEl = document.getElementById('res-balance');

  if (efectivoEl) efectivoEl.textContent = fmt(salesTotals.efectivo);
  if (tarjetaEl) tarjetaEl.textContent = fmt(salesTotals.tarjeta);
  if (transferEl) transferEl.textContent = fmt(salesTotals.transferencia);
  if (totalEl) totalEl.textContent = fmt(totalVentas);
  if (gastosEl) gastosEl.textContent = fmt(totalGastos);
  if (balanceEl) balanceEl.textContent = fmt(balance);
}

function getPendingSupplierInvoicesForCash() {
  return (DB.facturasProveedores || [])
    .filter((invoice) => Number(invoice.montoPendiente || 0) > 0)
    .sort((a, b) => Number(b.montoPendiente || 0) - Number(a.montoPendiente || 0));
}

function buildCashExpenseSupplierOptions(selectedId = '') {
  const invoices = getPendingSupplierInvoicesForCash();
  const normalized = String(selectedId || '');
  if (!invoices.length) {
    return '<option value="">No hay facturas pendientes</option>';
  }
  return [
    '<option value="">Selecciona una factura pendiente</option>',
    ...invoices.map((invoice) => `
      <option value="${invoice.id}" ${normalized === String(invoice.id) ? 'selected' : ''}>
        ${invoice.proveedor} · ${invoice.numeroFactura} · ${fmt(invoice.montoPendiente)}
      </option>
    `)
  ].join('');
}

function openCashExpenseModal(defaultType = 'gasto') {
  if (!DB.config.cajaAbierta) {
    showToast('Primero debes abrir la caja para registrar un egreso.', 'warning');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  title.textContent = 'Registrar egreso';
  body.innerHTML = `
    <div class="modal-grid">
      <div class="form-group">
        <label>Tipo de egreso</label>
        <select id="cash-expense-type" class="form-input" onchange="syncCashExpenseFields()">
          <option value="gasto" ${defaultType === 'gasto' ? 'selected' : ''}>Gastos</option>
          <option value="pago_suplidor" ${defaultType === 'pago_suplidor' ? 'selected' : ''}>Pago a suplidor</option>
          <option value="devolucion" ${defaultType === 'devolucion' ? 'selected' : ''}>Devolución</option>
          <option value="retiro_efectivo" ${defaultType === 'retiro_efectivo' ? 'selected' : ''}>Retiro de efectivo</option>
        </select>
      </div>
      <div class="form-group">
        <label>Monto</label>
        <input type="number" id="cash-expense-amount" class="form-input" min="0.01" step="0.01" placeholder="0.00" value="">
      </div>
      <div class="form-group span-full hidden" id="cash-expense-supplier-group">
        <label>Factura de suplidor</label>
        <select id="cash-expense-supplier-invoice" class="form-input" onchange="syncCashExpenseFields()">
          ${buildCashExpenseSupplierOptions()}
        </select>
        <div class="products-subtle" id="cash-expense-supplier-help" style="margin-top:0.45rem">
          Selecciona la factura pendiente que vas a pagar desde caja.
        </div>
      </div>
      <div class="form-group span-full">
        <label>Observación</label>
        <textarea id="cash-expense-notes" class="form-input" rows="4" placeholder="Ej: pago de luz, retiro administrativo, devolución al cliente..."></textarea>
      </div>
      <div class="form-group span-full">
        <div class="cash-expense-inline">
          <div class="cash-expense-inline-card">
            <span>Efectivo disponible</span>
            <strong>${fmt(DB.config.cajaMonto || 0)}</strong>
          </div>
          <div class="cash-expense-inline-card">
            <span>Caja</span>
            <strong>${DB.config.cajaAbierta ? 'Abierta' : 'Cerrada'}</strong>
          </div>
        </div>
      </div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="saveCashExpense()">Registrar egreso</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  syncCashExpenseFields();
  setTimeout(() => document.getElementById('cash-expense-amount')?.focus(), 0);
}

function syncCashExpenseFields() {
  const type = document.getElementById('cash-expense-type')?.value || 'gasto';
  const supplierGroup = document.getElementById('cash-expense-supplier-group');
  const supplierSelect = document.getElementById('cash-expense-supplier-invoice');
  const amountInput = document.getElementById('cash-expense-amount');
  const notesInput = document.getElementById('cash-expense-notes');
  if (supplierGroup) supplierGroup.classList.toggle('hidden', type !== 'pago_suplidor');
  if (supplierSelect) {
    supplierSelect.innerHTML = buildCashExpenseSupplierOptions(supplierSelect.value);
  }

  const placeholders = {
    gasto: 'Ej: luz, transporte, compra menor, limpieza...',
    pago_suplidor: 'Ej: pago parcial de factura, compra a crédito...',
    devolucion: 'Ej: devolución por producto devuelto o factura anulada...',
    retiro_efectivo: 'Ej: retiro administrativo o depósito bancario...'
  };
  if (notesInput) notesInput.placeholder = placeholders[type] || placeholders.gasto;

  if (type === 'pago_suplidor' && supplierSelect) {
    const selected = getPendingSupplierInvoicesForCash().find((invoice) => String(invoice.id) === String(supplierSelect.value));
    if (selected && amountInput && (!Number(amountInput.value) || Number(amountInput.value) > Number(selected.montoPendiente || 0))) {
      amountInput.value = Number(selected.montoPendiente || 0).toFixed(2);
    }
  }
}

async function saveCashExpense() {
  const type = document.getElementById('cash-expense-type')?.value || 'gasto';
  const amount = Number(document.getElementById('cash-expense-amount')?.value || 0);
  const notes = String(document.getElementById('cash-expense-notes')?.value || '').trim();
  const supplierInvoiceId = Number(document.getElementById('cash-expense-supplier-invoice')?.value || 0);

  if (!amount || amount <= 0) {
    showToast('Indica un monto válido para el egreso.', 'error');
    return;
  }
  if (type === 'pago_suplidor' && !supplierInvoiceId) {
    showToast('Selecciona una factura pendiente del suplidor.', 'error');
    return;
  }

  try {
    const response = await api.createCashExpense({
      tipo: type,
      monto: amount,
      obs: notes,
      supplierInvoiceId,
      ...getBusinessStructurePayload(),
      ...getActorPayload()
    });
    if (response.config) DB.config = { ...DB.config, ...response.config };
    if (response.movement) DB.movimientosCaja.unshift(response.movement);
    if (response.supplierInvoice) {
      const idx = (DB.facturasProveedores || []).findIndex((item) => item.id === response.supplierInvoice.id);
      if (idx >= 0) {
        DB.facturasProveedores[idx] = response.supplierInvoice;
      } else {
        DB.facturasProveedores.unshift(response.supplierInvoice);
      }
      if (typeof loadProveedoresTable === 'function') loadProveedoresTable();
      if (typeof updateProveedoresStats === 'function') updateProveedoresStats();
    }
    closeAllModals();
    syncCajaState();
    updateReportes();
    refreshAuditLogs();
    updateNotifications();
    showToast('Egreso registrado correctamente', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo registrar el egreso.', 'error');
  }
}

function openCashIncomeModal() {
  if (!DB.config.cajaAbierta) {
    showToast('Primero debes abrir la caja para registrar un ingreso.', 'warning');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  title.textContent = 'Registrar ingreso';
  body.innerHTML = `
    <div class="modal-grid">
      <div class="form-group">
        <label>Monto</label>
        <input type="number" id="cash-income-amount" class="form-input" min="0.01" step="0.01" placeholder="0.00" value="">
      </div>
      <div class="form-group">
        <label>Tipo</label>
        <input type="text" class="form-input" value="Ingreso adicional" disabled>
      </div>
      <div class="form-group span-full">
        <label>Observación</label>
        <textarea id="cash-income-notes" class="form-input" rows="4" placeholder="Ej: dinero entregado por el dueño, ajuste positivo de caja, cobro externo..."></textarea>
      </div>
      <div class="form-group span-full">
        <div class="cash-expense-inline">
          <div class="cash-expense-inline-card">
            <span>Efectivo actual</span>
            <strong>${fmt(DB.config.cajaMonto || 0)}</strong>
          </div>
          <div class="cash-expense-inline-card">
            <span>Destino</span>
            <strong>Caja abierta</strong>
          </div>
        </div>
      </div>
    </div>
  `;
  footer.innerHTML = `
    <button class="btn-secondary" type="button" onclick="closeAllModals()">Cancelar</button>
    <button class="btn-primary" type="button" onclick="saveCashIncome()">Registrar ingreso</button>
  `;
  overlay.classList.remove('hidden');
  translateDynamicUi(overlay);
  setTimeout(() => document.getElementById('cash-income-amount')?.focus(), 0);
}

async function saveCashIncome() {
  const amount = Number(document.getElementById('cash-income-amount')?.value || 0);
  const notes = String(document.getElementById('cash-income-notes')?.value || '').trim();

  if (!amount || amount <= 0) {
    showToast('Indica un monto válido para el ingreso.', 'error');
    return;
  }

  try {
    const response = await api.createCashIncome({
      monto: amount,
      obs: notes,
      ...getBusinessStructurePayload(),
      ...getActorPayload()
    });
    if (response.config) DB.config = { ...DB.config, ...response.config };
    if (response.movement) DB.movimientosCaja.unshift(response.movement);
    closeAllModals();
    syncCajaState();
    updateReportes();
    refreshAuditLogs();
    updateNotifications();
    showToast('Ingreso registrado correctamente', 'success');
  } catch (error) {
    showToast(error.message || 'No se pudo registrar el ingreso.', 'error');
  }
}

function getPendingDeliveryCashSales() {
  return (DB.ventas || []).filter((sale) =>
    sale.tipoPedido === 'delivery' &&
    sale.metodo === 'contra_entrega' &&
    !sale.cancelada &&
    (sale.estadoCobroDelivery || 'pendiente') === 'pendiente'
  );
}

function renderPendingDeliveryCash() {
  const box = document.getElementById('delivery-cash-pending-list');
  if (!box) return;
  const pending = getPendingDeliveryCashSales();
  if (!pending.length) {
    box.innerHTML = '<p class="text-muted">No hay cobros pendientes de delivery.</p>';
    return;
  }
  box.innerHTML = pending.map((sale) => `
    <div class="cash-movement-item">
      <div class="cash-movement-main">
        <div class="cash-movement-title">${sale.id}</div>
        <div class="cash-movement-meta">${sale.repartidor || 'Delivery sin asignar'} · ${sale.cliente || 'Consumidor Final'}</div>
        <div class="cash-movement-notes">${sale.direccionDelivery || 'Sin dirección'}${sale.telefonoDelivery ? ` · ${sale.telefonoDelivery}` : ''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem">
        <div class="cash-movement-amount">${fmt(sale.total)}</div>
        <button class="btn-primary" onclick="settleDeliveryCash('${sale.id}')">Validar pago</button>
      </div>
    </div>
  `).join('');
}

async function settleDeliveryCash(invoiceNumber) {
  const sale = (DB.ventas || []).find((item) => item.id === invoiceNumber);
  if (!sale) {
    showToast('No se encontró la factura contra entrega.', 'error');
    return;
  }
  if (!confirm(`¿Validar el pago contra entrega de ${invoiceNumber} por ${fmt(sale.total)}?`)) {
    return;
  }

  try {
    const response = await api.settleDeliveryCash(invoiceNumber, {
      ...getActorPayload()
    });
    const updatedSale = response.sale;
    DB.ventas = DB.ventas.map((item) => item.id === updatedSale.id ? updatedSale : item);
    if (response.config) DB.config = { ...DB.config, ...response.config };
    DB.movimientosCaja.unshift({
      tipo: 'Contra entrega validado',
      monto: Number(updatedSale.total || 0),
      hora: new Date().toLocaleString('es-DO'),
      obs: `${updatedSale.id} · ${updatedSale.repartidor || 'Delivery'}`,
      usuarioId: DB.currentUser?.id || null,
      usuarioNombre: DB.currentUser?.nombre || DB.currentUser?.usuario || 'Sistema'
    });
    syncCajaState();
    loadVentasHistory();
    updateReportes();
    refreshAuditLogs();
    showToast(`Pago validado para ${invoiceNumber}`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function formatCashMovementDate(value) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('es-DO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function fmt(val) {
  return DB.config.moneda + ' ' + parseFloat(val || 0).toLocaleString('es-DO', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function buildOperationalNotifications(limit = 4) {
  const recentSales = (DB.ventas || [])
    .filter((sale) => sale && !sale.cancelada && String(sale.estadoVenta || 'pagada').trim() === 'pagada')
    .slice(0, 2)
    .map((sale) => ({
      severity: 'success',
      title: 'Venta registrada',
      text: `${sale.id || 'Factura'} · ${sale.cliente || 'Consumidor Final'} · ${fmt(sale.total)}`,
      time: formatCashMovementDate(sale.cobradaEn || sale.fecha)
    }));

  const recentCashMovements = (DB.movimientosCaja || [])
    .filter((mov) => mov && mov.tipo)
    .slice(0, 2)
    .map((mov) => ({
      severity: Number(mov.monto || 0) < 0 ? 'warning' : 'info',
      title: `Caja: ${mov.tipo}`,
      text: `${mov.obs || 'Movimiento registrado'} · ${fmt(mov.monto)}`,
      time: formatCashMovementDate(mov.hora)
    }));

  return [...recentSales, ...recentCashMovements].slice(0, limit);
}

function buildNotifications() {
  const notifications = [];

  // ── Actualización del sistema disponible ──────────────────────────────────
  if (window._updAvailable?.version) {
    const typeLabel = window._updAvailable.type === 'feature' ? 'Nueva función' :
                      window._updAvailable.type === 'critical' ? '¡Crítica!' : 'Actualización';
    notifications.push({
      severity : 'warning',
      title    : `Sistema: ${typeLabel} disponible`,
      text     : `Versión ${window._updAvailable.version} lista para descargar${window._updAvailable.size ? ' · ' + window._updAvailable.size : ''}. Ve a Configuración → Actualización.`,
      time     : 'Sistema'
    });
  }

  const lowStock = DB.productos.filter((p) => p.estado === 'Activo' && p.stock > 0 && p.stock <= p.stockMin);
  const outStock = DB.productos.filter((p) => p.stock === 0);

  if (lowStock.length) {
    notifications.push({
      severity: 'warning',
      title: 'Productos con stock bajo',
      text: `${lowStock.length} producto(s) requieren reposición pronto.`,
      time: 'Inventario'
    });
  }

  if (outStock.length) {
    notifications.push({
      severity: 'danger',
      title: 'Productos agotados',
      text: `${outStock.length} producto(s) están agotados.`,
      time: 'Inventario'
    });
  }

  if (DB.currentUser && !cajaAbierta) {
    notifications.push({
      severity: 'info',
      title: 'Caja pendiente de apertura',
      text: 'Debes abrir la caja antes de procesar ventas.',
      time: 'Caja'
    });
  }

  if (DB.config?.licenseStatus === 'suspended') {
    notifications.push({
      severity: 'danger',
      title: 'Licencia suspendida',
      text: 'La licencia fue suspendida desde el panel administrador y el acceso puede ser bloqueado en cualquier momento.',
      time: 'Sistema'
    });
  } else if (DB.config?.trialExpired) {
    notifications.push({
      severity: 'danger',
      title: 'Licencia vencida',
      text: 'La prueba del sistema expiró y debes activarla para seguir operando con normalidad.',
      time: 'Sistema'
    });
  } else if (DB.config?.licenseStatus !== 'active') {
    notifications.push({
      severity: 'warning',
      title: 'Prueba activa',
      text: `Te quedan ${Number(DB.config?.trialDaysLeft || 0)} día(s) de prueba completa.`,
      time: 'Sistema'
    });
  }

  if (DB.ventasPendientes.length) {
    notifications.push({
      severity: 'warning',
      title: 'Ventas suspendidas',
      text: `Tienes ${DB.ventasPendientes.length} venta(s) pendiente(s) por recuperar.`,
      time: 'Ventas'
    });
  }

  if (DB.cotizaciones?.length) {
    notifications.push({
      severity: 'info',
      title: 'Cotizaciones guardadas',
      text: `Tienes ${DB.cotizaciones.length} cotización(es) lista(s) para recuperar.`,
      time: 'Ventas'
    });
  }

  const pendingDeliveryCash = getPendingDeliveryCashSales();
  if (pendingDeliveryCash.length) {
    notifications.push({
      severity: 'warning',
      title: 'Contra entrega pendiente',
      text: `${pendingDeliveryCash.length} pedido(s) delivery siguen sin liquidar en caja.`,
      time: 'Caja'
    });
  }

  const recentAudit = (DB.movimientosSistema || []).slice(0, 4).map((item) => ({
    severity: 'info',
    title: `${item.modulo}: ${item.accion}`,
    text: item.detalle || 'Movimiento registrado en el sistema.',
    time: item.fecha
  }));

  const recentActivity = recentAudit.length ? recentAudit : buildOperationalNotifications();
  return [...notifications, ...recentActivity];
}

function getNotificationBadgeColor(severity) {
  if (severity === 'danger') return 'var(--danger)';
  if (severity === 'warning') return 'var(--warning)';
  if (severity === 'success') return 'var(--success)';
  return 'var(--info)';
}

function updateNotifications() {
  const badge = document.getElementById('notif-badge');
  const body = document.getElementById('notif-panel-body');
  if (!badge || !body) return;

  const notifications = buildNotifications();
  const unseen = Math.max(0, notifications.length - notificationsSeenCount);
  badge.textContent = unseen;
  badge.classList.toggle('hidden', unseen === 0);

  if (!notifications.length) {
    body.innerHTML = '<div class="notif-empty">No hay notificaciones nuevas.</div>';
    return;
  }

  body.innerHTML = notifications.map((item) => `
    <div class="notif-item">
      <div class="notif-item-title">
        <span style="color:${getNotificationBadgeColor(item.severity)}">${item.title}</span>
        <span class="notif-item-time">${item.time}</span>
      </div>
      <div class="notif-item-text">${item.text}</div>
    </div>
  `).join('');
}

function toggleNotifications(event) {
  event.stopPropagation();
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  updateNotifications();
  panel.classList.toggle('hidden');
}

function closeNotifications() {
  const panel = document.getElementById('notif-panel');
  if (panel) panel.classList.add('hidden');
}

function markNotificationsSeen(event) {
  event.stopPropagation();
  notificationsSeenCount = buildNotifications().length;
  updateNotifications();
}

// ─── Cola de Cobro ────────────────────────────────────────────────────────────

let _colaCobroData = [];

function syncColaCobróNav() {
  const navEl = document.getElementById('nav-cola-cobro');
  if (!navEl) return;
  const billingCaps = getEffectiveBillingCapabilities();
  const showNav = billingCaps.canChargePending;
  navEl.style.display = showNav ? '' : 'none';
  const badge = document.getElementById('cola-cobro-badge');
  if (badge) {
    const count = _colaCobroData.length;
    badge.textContent = count > 0 ? String(count) : '';
    badge.style.display = count > 0 ? '' : 'none';
  }
}

async function loadColaCobro() {
  const billingCaps = getEffectiveBillingCapabilities();
  if (!billingCaps.canChargePending) {
    _colaCobroData = [];
    renderColaCobro(_colaCobroData);
    syncColaCobróNav();
    return;
  }
  try {
    const res = await api.getColaCobro();
    _colaCobroData = Array.isArray(res?.data) ? res.data : [];
    renderColaCobro(_colaCobroData);
    syncColaCobróNav();
  } catch (err) {
    showToast(err.message || 'Error al cargar cola de cobro.', 'error');
  }
}

function renderColaCobro(ventas) {
  const tbody = document.getElementById('cola-cobro-tbody');
  const tabla = document.getElementById('tabla-cola-cobro');
  const empty = document.getElementById('cola-cobro-empty');
  if (!tbody || !tabla || !empty) return;
  if (!ventas.length) {
    tabla.style.display = 'none';
    empty.style.display = '';
    return;
  }
  tabla.style.display = '';
  empty.style.display = 'none';
  tbody.innerHTML = ventas.map(v => {
    const fecha = v.created_at ? new Date(v.created_at).toLocaleString('es-DO') : '—';
    const total = Number(v.total || 0).toLocaleString('es-DO', { minimumFractionDigits: 2 });
    const cajaInfo = [v.sucursal_factura, v.caja_factura].filter(Boolean).join(' / ') || '—';
    return `<tr>
      <td><strong>${escHtml(v.invoice_number || String(v.id))}</strong></td>
      <td>${escHtml(v.cliente || 'Consumidor Final')}</td>
      <td style="font-size:0.82rem;color:var(--text2)">${escHtml(cajaInfo)}</td>
      <td style="font-size:0.82rem;color:var(--text2)">${escHtml(v.cajero_factura || '—')}</td>
      <td style="font-size:0.82rem">${escHtml(fecha)}</td>
      <td class="text-right"><strong>RD$ ${escHtml(total)}</strong></td>
      <td>
        <button class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.7rem" onclick="openCobrarModal(${v.id}, ${Number(v.total || 0)}, '${escHtml(v.invoice_number || String(v.id))}', '${escHtml(v.cliente || 'Consumidor Final')}')">💰 Cobrar</button>
      </td>
    </tr>`;
  }).join('');
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openCobrarModal(id, total, invoiceNumber, cliente) {
  const existing = document.getElementById('modal-cobrar-pendiente');
  if (existing) existing.remove();

  const fmtTotal = Number(total).toLocaleString('es-DO', { minimumFractionDigits: 2 });
  const html = `
  <div id="modal-cobrar-pendiente" class="modal-overlay active" onclick="if(event.target===this)closeCobrarModal()">
    <div class="cobrar-modal-box">
      <div class="cobrar-modal-header">
        <span class="cobrar-modal-title">Cobrar Factura</span>
        <button class="modal-close" onclick="closeCobrarModal()">✕</button>
      </div>

      <div class="cobrar-invoice-card">
        <div class="cobrar-invoice-badge">Factura</div>
        <div class="cobrar-invoice-num">${escHtml(invoiceNumber)}</div>
        <div class="cobrar-invoice-meta">${escHtml(cliente)}</div>
        <div class="cobrar-invoice-divider"></div>
        <div class="cobrar-invoice-total-row">
          <span class="cobrar-total-label">Total a cobrar</span>
          <span class="cobrar-total-amount">RD$ ${escHtml(fmtTotal)}</span>
        </div>
      </div>

      <div class="cobrar-modal-body">
        <div>
          <div class="cobrar-field-label">Monto recibido</div>
          <div class="cobrar-quick-btns">
            <button class="cobrar-quick-btn" onclick="setCobrarMonto(${total}, 200)">200</button>
            <button class="cobrar-quick-btn" onclick="setCobrarMonto(${total}, 500)">500</button>
            <button class="cobrar-quick-btn" onclick="setCobrarMonto(${total}, 1000)">1,000</button>
            <button class="cobrar-quick-btn" onclick="setCobrarMonto(${total}, 2000)">2,000</button>
            <button class="cobrar-quick-btn exact" onclick="setCobrarMonto(${total}, ${total})">Exacto</button>
          </div>
        </div>
        <input type="number" id="cobrar-recibido" class="cobrar-monto-input" value="${Number(total).toFixed(2)}" min="0" step="0.01"
          oninput="calcCobrarCambio(${total})"
          onkeydown="if(event.key==='Enter'){event.preventDefault();confirmarCobro(${id},${total},'print')}">
        <input type="hidden" id="cobrar-cambio" value="0.00">
        <div id="cobrar-cambio-box" class="cobrar-cambio-box">
          <span class="cobrar-cambio-label">Cambio</span>
          <span id="cobrar-cambio-display" class="cobrar-cambio-amount">RD$ 0.00</span>
        </div>
      </div>

      <div class="cobrar-modal-footer">
        <button class="cobrar-btn-primary" onclick="confirmarCobro(${id},${total},'print')">
          🖨️ Cobrar e imprimir
        </button>
        <div class="cobrar-btn-row">
          <button class="cobrar-btn-secondary" onclick="confirmarCobro(${id},${total},'whatsapp')">Cobrar y copiar</button>
          <button class="cobrar-btn-secondary" onclick="confirmarCobro(${id},${total},'charge')">Solo cobrar</button>
        </div>
        <button class="cobrar-btn-cancel" onclick="closeCobrarModal()">Cancelar</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => {
    const input = document.getElementById('cobrar-recibido');
    input?.focus();
    input?.select?.();
  }, 80);
}

function calcCobrarCambio(total) {
  const recibido = parseFloat(document.getElementById('cobrar-recibido')?.value || 0) || 0;
  const cambio = Math.max(0, recibido - Number(total));

  const cambioEl = document.getElementById('cobrar-cambio');
  if (cambioEl) cambioEl.value = cambio.toFixed(2);

  const display = document.getElementById('cobrar-cambio-display');
  const box = document.getElementById('cobrar-cambio-box');
  if (display) display.textContent = `RD$ ${cambio.toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
  if (box) box.classList.toggle('has-cambio', cambio > 0);
}

function setCobrarMonto(total, amount) {
  const input = document.getElementById('cobrar-recibido');
  if (!input) return;
  input.value = Number(amount).toFixed(2);
  calcCobrarCambio(total);
}

function closeCobrarModal() {
  document.getElementById('modal-cobrar-pendiente')?.remove();
}

function upsertQueuedSaleInLocalState(sale) {
  if (!sale) return;
  if (!Array.isArray(DB.ventas)) DB.ventas = [];

  const saleId = Number(sale.ventaId || 0) || 0;
  const invoiceNumber = String(sale.id || '').trim();
  const existingIndex = DB.ventas.findIndex((item) => {
    const itemSaleId = Number(item?.ventaId || 0) || 0;
    const itemInvoiceNumber = String(item?.id || '').trim();
    return (saleId > 0 && itemSaleId === saleId) || (invoiceNumber && itemInvoiceNumber === invoiceNumber);
  });

  if (existingIndex >= 0) {
    DB.ventas[existingIndex] = sale;
    return;
  }

  DB.ventas.unshift(sale);
}

async function confirmarCobro(id, total, action = 'charge') {
  const billingCaps = getEffectiveBillingCapabilities();
  if (!billingCaps.canChargePending) {
    showToast(`Tu usuario está configurado como ${billingCaps.userTypeLabel} y no puede cobrar facturas pendientes.`, 'warning');
    return;
  }
  const recibido = parseFloat(document.getElementById('cobrar-recibido')?.value || total) || Number(total);
  const cambio = Math.max(0, recibido - Number(total));
  try {
    const response = await api.cobrarPendiente(id, { recibido, cambio, ...getActorPayload(), ...getBusinessStructurePayload() });
    const savedVenta = response?.sale || null;
    if (!savedVenta) {
      throw new Error('El servidor registrÃ³ el cobro, pero no devolviÃ³ la factura lista para imprimir.');
    }

    if (response?.config) {
      DB.config = { ...DB.config, ...response.config };
    }
    upsertQueuedSaleInLocalState(savedVenta);
    closeCobrarModal();
    syncCajaState();
    showReceipt(savedVenta, { pending: false, title: 'Factura cobrada' });
    showToast('Cobro registrado correctamente.', 'success');

    if (typeof loadVentasHistory === 'function') loadVentasHistory();
    if (typeof updateReportes === 'function') updateReportes();
    if (typeof syncConfigForm === 'function') syncConfigForm();
    if (typeof syncSaleFiscalControls === 'function') syncSaleFiscalControls();
    if (typeof refreshAuditLogs === 'function') refreshAuditLogs();
    if (typeof updateNotifications === 'function') updateNotifications();
    if (typeof loadColaCobro === 'function') loadColaCobro();
    if (typeof _tryOpenCashDrawer === 'function') _tryOpenCashDrawer();
    if (typeof _tryAutoSaveInvoicePdf === 'function') _tryAutoSaveInvoicePdf(savedVenta);

    if (action === 'print' && typeof printReceipt === 'function') {
      printReceipt(savedVenta).catch((err) => {
        console.warn('[cola-cobro] Error imprimiendo recibo:', err);
        showToast('No se pudo imprimir la factura. Revisa la impresora.', 'error');
      });
    } else if (action === 'whatsapp' && typeof sendReceiptToWhatsApp === 'function') {
      await sendReceiptToWhatsApp(savedVenta);
    }
  } catch (err) {
    showToast(err.message || 'Error al registrar cobro.', 'error');
  }
}

// ─── Gestión de tipo de caja (panel de config) ────────────────────────────────

function renderCashRegisterTypesPanel() {
  const container = document.getElementById('cfg-cash-register-types-list');
  if (!container) return;
  const cajas = DB.cajasSucursal || [];
  if (!cajas.length) {
    container.innerHTML = '<p style="color:var(--text2);font-size:0.85rem">No hay cajas registradas.</p>';
    return;
  }
  const tipoOpciones = [
    { value: 'mixta', label: 'Mixta (factura y cobra)' },
    { value: 'facturacion', label: 'Facturación (solo emite, pasa a cobro)' },
    { value: 'cobro', label: 'Cobro (solo cobra facturas pendientes)' },
    { value: 'centralizadora', label: 'Centralizadora' }
  ];
  container.innerHTML = cajas.map(caja => {
    const opts = tipoOpciones.map(o => `<option value="${o.value}"${caja.tipoCaja === o.value ? ' selected' : ''}>${o.label}</option>`).join('');
    return `<div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.6rem">
      <span style="flex:1;font-size:0.88rem;font-weight:500">${escHtml(caja.nombre)}${caja.codigo ? ` <small style="color:var(--text2)">(${escHtml(caja.codigo)})</small>` : ''}</span>
      <select class="form-input" style="max-width:220px;font-size:0.82rem" onchange="saveCashRegisterTipoCaja(${caja.id}, this.value)">${opts}</select>
    </div>`;
  }).join('');
}

async function saveCashRegisterTipoCaja(id, tipoCaja) {
  try {
    const res = await api.updateCashRegister(id, { tipoCaja, ...getActorPayload() });
    const updated = res?.caja;
    if (updated) {
      const idx = (DB.cajasSucursal || []).findIndex(c => Number(c.id) === Number(id));
      if (idx >= 0) DB.cajasSucursal[idx] = { ...DB.cajasSucursal[idx], ...updated };
    }
    showToast('Tipo de caja actualizado.', 'success');
    syncColaCobróNav();
  } catch (err) {
    showToast(err.message || 'Error al actualizar tipo de caja.', 'error');
  }
}

// ─── Plan comercial ───────────────────────────────────────────────────────────

const PLAN_DEFINITIONS = [
  {
    code: 'basico',
    icon: '🏪',
    name: 'Tecno Caja Básico',
    price: 'USD $149 — pago único',
    features: [
      'Ventas y facturación',
      'Inventario y productos',
      'Clientes y crédito',
      'Caja y reportes',
      'Usuarios ilimitados',
      'NCF (DGII)',
      'e-CF DGII (módulo básico)',
      'Soporte por correo',
    ],
  },
  {
    code: 'pro',
    icon: '🚀',
    name: 'Tecno Caja Pro',
    price: 'USD $19 / mes',
    features: [
      'Todo lo de Básico',
      'POS Móvil (app)',
      'Multicaja',
      'Historial de movimientos',
      'Sincronización en la nube',
      'e-CF DGII (completo)',
      'Soporte por WhatsApp',
    ],
  },
  {
    code: 'plus',
    icon: '🏢',
    name: 'Tecno Caja Plus',
    price: 'USD $99 / mes',
    features: [
      'Todo lo de Pro',
      'Multisucursal',
      'e-CF DGII (avanzado + auditoría)',
      'Soporte telefónico prioritario',
      'Reportes consolidados',
    ],
  },
];

let _selectedPlanCode = null;

function getEffectiveCurrentPlanCode() {
  if (window.TecnoCajaPlans && typeof window.TecnoCajaPlans.getCurrentPlanCode === 'function') {
    return window.TecnoCajaPlans.getCurrentPlanCode();
  }
  return String(DB.config?.planCode || 'basico').toLowerCase();
}

function renderPlanSection() {
  const section = document.getElementById('cfg-plan-section');
  if (!section) return;

  const isAdmin = isAdministrator();
  section.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;

  // Leer el plan actual directo de DB y sincronizar el badge del topbar
  const currentCode = getEffectiveCurrentPlanCode();
  _updatePlanBadge();

  // Resetear selección si el plan actual cambió externamente
  if (!_selectedPlanCode || !PLAN_DEFINITIONS.find(p => p.code === _selectedPlanCode)) {
    _selectedPlanCode = currentCode;
  }

  const container = document.getElementById('cfg-plan-cards');
  if (!container) return;

  container.innerHTML = PLAN_DEFINITIONS.map(plan => {
    const isCurrent = plan.code === currentCode;
    const isSelected = plan.code === _selectedPlanCode;
    return `<div
      class="plan-card${isCurrent ? ' current' : ''}${isSelected ? ' selected' : ''}"
      onclick="selectPlan('${plan.code}')"
    >
      <div class="plan-card-icon">${plan.icon}</div>
      <div class="plan-card-name">${plan.name}</div>
      <div class="plan-card-price">${plan.price}</div>
      <ul class="plan-card-features">
        ${plan.features.map(f => `<li>${escHtml(f)}</li>`).join('')}
      </ul>
    </div>`;
  }).join('');

  const btn = document.getElementById('cfg-btn-apply-plan');
  if (btn) btn.disabled = _selectedPlanCode === currentCode;
}

function selectPlan(code) {
  _selectedPlanCode = code;
  renderPlanSection();
}

function applyPlanChange() {
  if (!_selectedPlanCode) return;
  const currentCode = getEffectiveCurrentPlanCode();
  if (_selectedPlanCode === currentCode) return;

  const planDef = PLAN_DEFINITIONS.find(p => p.code === _selectedPlanCode);

  // Pedir contraseña de seguridad antes de cambiar el plan
  const existing = document.getElementById('modal-plan-password');
  if (existing) existing.remove();

  const html = `
  <div id="modal-plan-password" class="modal-overlay active" onclick="if(event.target===this)closePlanPasswordModal()">
    <div class="modal-box" style="max-width:380px">
      <div class="modal-header">
        <h3>Confirmar cambio de plan</h3>
        <button class="modal-close" onclick="closePlanPasswordModal()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:1rem">
        <p style="font-size:0.88rem;color:var(--text2);margin:0">
          Vas a activar <strong>${escHtml(planDef?.name || _selectedPlanCode)}</strong>.
          Ingresa la contraseña de seguridad para confirmar.
        </p>
        <div class="form-group" style="position:relative">
          <label>Contraseña de seguridad</label>
          <div style="position:relative">
            <input type="password" id="plan-security-password" class="form-input"
              placeholder="••••••••" style="padding-right:2.5rem"
              onkeydown="if(event.key==='Enter')confirmPlanPasswordAndApply()">
            <button type="button" class="password-toggle"
              onclick="togglePasswordVisibility('plan-security-password',this)"
              style="position:absolute;right:0.6rem;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text2);font-size:1rem">👁</button>
          </div>
          <small id="plan-password-error" style="color:var(--danger);display:none;margin-top:0.3rem"></small>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closePlanPasswordModal()">Cancelar</button>
        <button class="btn-primary" onclick="confirmPlanPasswordAndApply()">✅ Activar plan</button>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(() => document.getElementById('plan-security-password')?.focus(), 80);
}

function closePlanPasswordModal() {
  document.getElementById('modal-plan-password')?.remove();
}

async function confirmPlanPasswordAndApply() {
  const password = document.getElementById('plan-security-password')?.value || '';
  const errorEl = document.getElementById('plan-password-error');

  if (!password) {
    if (errorEl) { errorEl.textContent = 'Ingresa la contraseña de seguridad.'; errorEl.style.display = ''; }
    return;
  }

  const btn = document.querySelector('#modal-plan-password .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }

  try {
    await api.verifySecurityPassword({ password });
  } catch (_) {
    if (errorEl) { errorEl.textContent = 'Contraseña incorrecta.'; errorEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✅ Activar plan'; }
    return;
  }

  closePlanPasswordModal();

  try {
    const res = await api.request('/api/license/set-plan', {
      method: 'POST',
      body: JSON.stringify({ planCode: _selectedPlanCode, ...getActorPayload() })
    });
    DB.config = { ...DB.config, planCode: res.planCode, planName: res.planName, businessStructureMode: res.businessStructureMode };
    _selectedPlanCode = res.planCode;
    showToast(`Plan activado: ${res.planName}`, 'success');
    renderPlanSection();
    _updatePlanBadge();
    applyRolePermissions();
    syncBusinessStructureControls();
  } catch (err) {
    showToast(err.message || 'Error al cambiar el plan.', 'error');
  }
}
