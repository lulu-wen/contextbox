/**
 * ContextBox — 事實 key 註冊表
 *
 * 這一份是單一真相來源，同時被四個地方吃：
 *   1. 事實庫    決定 key 合不合法、值是什麼型別
 *   2. 抽取層    告訴模型可以抽哪些 key（schema 就從這裡生）
 *   3. 擴充套件  autocomplete 與 aliases 就是欄位對應的第 1、2 層
 *   4. 排程器    expiry 決定哪些事實會爛掉、什麼時候回頭問你
 *
 * key 命名規則
 *   - 全小寫，點分隔，名詞單數：person.name.full
 *   - 可重複的用 []：education[].school → 存進去變成 education[0].school
 *   - 一旦發布就不改名。要改用新 key + supersedes 串回去。
 */

/** key 表的版本。改過 key 就要進版，事實庫靠這個做遷移。 */
export const SCHEMA_VERSION = '1.2.0'

export type Sensitivity =
  | 'public'     // 本來就印在履歷上
  | 'normal'     // 聯絡得到你，但不致命
  | 'sensitive'  // 每次自動填入都要再點一次
  | 'secret'     // 根本不存。註冊表裡不該出現這一級。

export type ExpiryPolicy =
  | 'never'      // 姓名、生日、已結束的學經歷
  | 'months:6'   // 現職、求職條件、可上班日
  | 'months:12'  // 聯絡方式、技能年資
  | 'explicit'   // 值本身帶到期日（證照、居留證）

/**
 * 這個欄位要怎麼填。
 *
 *  direct  —— 值是確定的，擴充套件直接填。姓名、生日、戶籍地址。
 *  pick    —— 庫裡有好幾筆，要先選一筆。學歷三筆，「最高學歷學校」只放一筆。
 *  compose —— 要當場寫出來的長文。自傳、工作說明、求職信。
 *             這種永遠不自動填，交給 agent 生成，再讓人過目。
 */
export type FillMode = 'direct' | 'pick' | 'compose'

export type ValueType =
  | 'string' | 'text' | 'number' | 'boolean'
  | 'date'   // YYYY-MM-DD
  | 'month'  // YYYY-MM
  | 'enum' | 'url' | 'email' | 'tel' | 'file'

export type FactKeyDef = {
  key: string
  label: string
  type: ValueType
  enum?: string[]
  sensitivity: Sensitivity
  expiry: ExpiryPolicy
  /** W3C autocomplete token — 擴充套件對應的第 1 層，零成本零延遲 */
  autocomplete?: string
  /** 中文欄位標籤別名 — 擴充套件對應的第 2 層 */
  aliases: string[]
  /** 可重複：education[]、work[] */
  repeatable?: boolean
  /** 不寫就照 fillModeOf() 推導。只有推導錯的才手動指定。 */
  fill?: FillMode
  note?: string
}

/**
 * 填法用推的，不要手標 75 次——手標一定會漏。
 *   長文（text）        → compose
 *   可重複的（[]）      → pick
 *   其他                → direct
 */
export function fillModeOf(d: FactKeyDef): FillMode {
  if (d.fill) return d.fill
  if (d.type === 'text') return 'compose'
  if (d.repeatable) return 'pick'
  return 'direct'
}

// ──────────────────────────────────────────────────────────────
// 一、基本身分
// ──────────────────────────────────────────────────────────────
const PERSON: FactKeyDef[] = [
  { key: 'person.name.full', label: '姓名', type: 'string',
    sensitivity: 'public', expiry: 'never', autocomplete: 'name',
    aliases: ['姓名', '真實姓名', '中文姓名', '申請人姓名', '報名人姓名', '本名'] },

  { key: 'person.name.family', label: '姓', type: 'string',
    sensitivity: 'public', expiry: 'never', autocomplete: 'family-name',
    aliases: ['姓', '姓氏'] },

  { key: 'person.name.given', label: '名', type: 'string',
    sensitivity: 'public', expiry: 'never', autocomplete: 'given-name',
    aliases: ['名', '名字'] },

  { key: 'person.name.en', label: '英文姓名', type: 'string',
    sensitivity: 'public', expiry: 'never',
    aliases: ['英文姓名', '護照英文姓名', 'English Name', '拼音姓名'],
    note: '以護照上的拼法為準。不宣告 autocomplete：標準的 name 是給本名的，搶了會害姓名對錯。' },

  { key: 'person.gender', label: '性別', type: 'enum',
    enum: ['男', '女', '不揭露'],
    sensitivity: 'normal', expiry: 'never', autocomplete: 'sex',
    aliases: ['性別'] },

  { key: 'person.birthdate', label: '出生日期', type: 'date',
    sensitivity: 'sensitive', expiry: 'never', autocomplete: 'bday',
    aliases: ['出生日期', '生日', '出生年月日', '出生年月'],
    note: '一律存西元。民國年在抽取層就要轉掉。' },

  { key: 'person.nationality', label: '國籍', type: 'string',
    sensitivity: 'normal', expiry: 'never', aliases: ['國籍'] },

  { key: 'person.military', label: '兵役狀況', type: 'enum',
    enum: ['役畢', '免役', '未服役', '替代役畢', '不適用'],
    sensitivity: 'normal', expiry: 'months:12',
    aliases: ['兵役狀況', '兵役', '役別'] },

  { key: 'person.marital_status', label: '婚姻狀況', type: 'enum',
    enum: ['未婚', '已婚', '不揭露'],
    sensitivity: 'normal', expiry: 'months:12',
    aliases: ['婚姻狀況', '婚姻'],
    note: '台灣表單很愛問。預設可填，但你隨時可以改成不揭露。' },

  { key: 'person.website', label: '個人網站', type: 'url',
    sensitivity: 'public', expiry: 'months:12', autocomplete: 'url',
    aliases: ['個人網站', '個人網頁', '個人首頁', '部落格', 'Blog', 'personal website'] },

  { key: 'person.disability', label: '身心障礙身分', type: 'string',
    sensitivity: 'sensitive', expiry: 'never',
    aliases: ['身心障礙', '身障類別', '身心障礙手冊'],
    note: '敏感。預設不填，由人每次決定要不要揭露。' },

  { key: 'person.photo', label: '大頭照', type: 'file',
    sensitivity: 'normal', expiry: 'months:12',
    aliases: ['照片', '大頭照', '個人照片', '證件照'] },
]

// ──────────────────────────────────────────────────────────────
// 二、證號（整組 sensitive）
// ──────────────────────────────────────────────────────────────
const IDENTITY: FactKeyDef[] = [
  { key: 'identity.national_id', label: '身分證字號', type: 'string',
    sensitivity: 'sensitive', expiry: 'never',
    aliases: ['身分證字號', '身份證字號', '身分證統一編號', '國民身分證號碼', '身分證號'] },

  { key: 'identity.passport_no', label: '護照號碼', type: 'string',
    sensitivity: 'sensitive', expiry: 'explicit',
    aliases: ['護照號碼', '護照號'],
    note: '護照本身會到期，expiresAt 跟著護照效期走' },

  { key: 'identity.arc_no', label: '居留證號', type: 'string',
    sensitivity: 'sensitive', expiry: 'explicit',
    aliases: ['居留證號', '統一證號', 'ARC'] },

  { key: 'identity.driver_license', label: '駕照號碼', type: 'string',
    sensitivity: 'sensitive', expiry: 'explicit',
    aliases: ['駕照號碼', '駕駛執照'] },
]

// ──────────────────────────────────────────────────────────────
// 三、聯絡方式
// ──────────────────────────────────────────────────────────────
const CONTACT: FactKeyDef[] = [
  { key: 'contact.email', label: '電子郵件', type: 'email',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'email',
    aliases: ['電子郵件', 'Email', 'E-mail', '信箱', '聯絡信箱', '電子信箱'] },

  { key: 'contact.phone.mobile', label: '手機', type: 'tel',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'tel',
    aliases: ['手機', '行動電話', '手機號碼', '聯絡電話', '行動電話號碼'],
    note: '存 E.164（+886912345678），顯示時再轉 0912-345-678' },

  { key: 'contact.phone.home', label: '住家電話', type: 'tel',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'home tel',
    aliases: ['住家電話', '室內電話', '市話'] },

  { key: 'contact.address.current', label: '通訊地址', type: 'string',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'street-address',
    aliases: ['通訊地址', '現居地址', '聯絡地址', '郵寄地址'] },

  { key: 'contact.address.registered', label: '戶籍地址', type: 'string',
    sensitivity: 'sensitive', expiry: 'months:12',
    aliases: ['戶籍地址', '戶籍所在地', '戶籍'],
    note: '比通訊地址敏感一級。政府表單常兩個都要，不要搞混。' },

  { key: 'contact.address.city', label: '縣市', type: 'string',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'address-level1',
    aliases: ['縣市', '居住縣市', '城市'] },

  { key: 'contact.address.district', label: '鄉鎮市區', type: 'string',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'address-level2',
    aliases: ['鄉鎮市區', '區', '行政區'] },

  { key: 'contact.address.postal_code', label: '郵遞區號', type: 'string',
    sensitivity: 'normal', expiry: 'months:12', autocomplete: 'postal-code',
    aliases: ['郵遞區號', '郵區', '郵號'] },

  { key: 'contact.line_id', label: 'LINE ID', type: 'string',
    sensitivity: 'normal', expiry: 'months:12', aliases: ['LINE ID', 'LINE'] },
]

// ──────────────────────────────────────────────────────────────
// 四、緊急聯絡人 —— 這是「別人的」個資，整組 sensitive
// ──────────────────────────────────────────────────────────────
const EMERGENCY: FactKeyDef[] = [
  { key: 'emergency.name', label: '緊急聯絡人姓名', type: 'string',
    sensitivity: 'sensitive', expiry: 'months:12',
    aliases: ['緊急聯絡人', '緊急聯絡人姓名', '緊急聯絡'] },
  { key: 'emergency.relation', label: '關係', type: 'string',
    sensitivity: 'sensitive', expiry: 'months:12',
    aliases: ['關係', '與本人關係', '稱謂'] },
  { key: 'emergency.phone', label: '緊急聯絡電話', type: 'tel',
    sensitivity: 'sensitive', expiry: 'months:12',
    aliases: ['緊急聯絡電話', '緊急聯絡人電話'] },
]

// ──────────────────────────────────────────────────────────────
// 五、學歷（可重複）
// ──────────────────────────────────────────────────────────────
const EDUCATION: FactKeyDef[] = [
  { key: 'education[].school', label: '學校名稱', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never',
    aliases: ['學校名稱', '畢業學校', '就讀學校', '學校', '最高學歷學校'] },
  { key: 'education[].department', label: '科系', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never',
    aliases: ['科系', '系所', '主修', '就讀科系', '畢業科系'] },
  { key: 'education[].degree', label: '學位', type: 'enum', repeatable: true,
    enum: ['博士', '碩士', '學士', '專科', '高中職', '國中', '其他'],
    sensitivity: 'public', expiry: 'never',
    aliases: ['學位', '學歷', '教育程度', '最高學歷'] },
  { key: 'education[].status', label: '就學狀態', type: 'enum', repeatable: true,
    enum: ['畢業', '肄業', '在學', '休學', '延畢'],
    sensitivity: 'public', expiry: 'months:6',
    aliases: ['就學狀態', '畢業狀態', '學歷狀態'],
    note: '「在學」會爛掉，所以有半年效期' },
  { key: 'education[].start', label: '入學年月', type: 'month', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['入學年月', '入學時間', '就讀期間起'] },
  { key: 'education[].end', label: '畢業年月', type: 'month', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['畢業年月', '畢業時間', '就讀期間迄'] },
  { key: 'education[].gpa', label: '成績', type: 'string', repeatable: true,
    sensitivity: 'normal', expiry: 'never', aliases: ['成績', 'GPA', '平均成績', '班排名'] },
  { key: 'education[].thesis', label: '論文題目', type: 'text', repeatable: true, fill: 'pick',
    sensitivity: 'public', expiry: 'never', aliases: ['論文題目', '畢業論文', '研究題目'],
    note: '是固定的事實不是生成物，所以覆寫成 pick' },
]

// ──────────────────────────────────────────────────────────────
// 六、工作經歷（可重複）
// ──────────────────────────────────────────────────────────────
const WORK: FactKeyDef[] = [
  { key: 'work[].company', label: '公司名稱', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never',
    aliases: ['公司名稱', '服務單位', '任職公司', '公司'] },
  { key: 'work[].title', label: '職稱', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never',
    aliases: ['職稱', '職務名稱', '擔任職務', '職位'] },
  { key: 'work[].industry', label: '產業類別', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['產業類別', '公司產業', '行業別'] },
  { key: 'work[].start', label: '到職年月', type: 'month', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['到職年月', '任職期間起', '起始年月'] },
  { key: 'work[].end', label: '離職年月', type: 'month', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['離職年月', '任職期間迄', '結束年月'],
    note: '空值代表現職' },
  { key: 'work[].is_current', label: '是否為現職', type: 'boolean', repeatable: true,
    sensitivity: 'public', expiry: 'months:6',
    aliases: ['現職', '目前任職'],
    note: '半年到期，排程器會回頭問你「還在這裡嗎」' },
  { key: 'work[].description', label: '工作內容', type: 'text', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['工作內容', '工作說明', '職務說明', '職務內容', '主要職責', '工作職掌'] },
  { key: 'work[].salary', label: '薪資', type: 'string', repeatable: true,
    sensitivity: 'sensitive', expiry: 'never',
    aliases: ['薪資', '月薪', '待遇', '年薪', '薪水'],
    note: '敏感。台灣求職表單很愛問，但這是你的議價籌碼。預設不自動填。' },
  { key: 'work[].leave_reason', label: '離職原因', type: 'text', repeatable: true,
    sensitivity: 'sensitive', expiry: 'never', aliases: ['離職原因', '離職理由'] },
]

// ──────────────────────────────────────────────────────────────
// 七、能力
// ──────────────────────────────────────────────────────────────
const ABILITY: FactKeyDef[] = [
  { key: 'skill[].name', label: '技能', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['技能', '專長', '專業技能', '擅長工具'] },
  { key: 'skill[].level', label: '熟練度', type: 'enum', repeatable: true,
    enum: ['精通', '熟悉', '略懂'],
    sensitivity: 'public', expiry: 'months:12', aliases: ['熟練度', '程度'] },
  { key: 'skill[].years', label: '年資', type: 'number', repeatable: true,
    sensitivity: 'public', expiry: 'months:12', aliases: ['年資', '使用年資', '經驗年數'],
    note: '年資會自己長大，每年要重算' },

  { key: 'language[].name', label: '語言', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['語言', '語文', '語文能力'] },
  { key: 'language[].listening', label: '聽', type: 'enum', repeatable: true,
    enum: ['精通', '中等', '略懂'], sensitivity: 'public', expiry: 'never', aliases: ['聽'] },
  { key: 'language[].speaking', label: '說', type: 'enum', repeatable: true,
    enum: ['精通', '中等', '略懂'], sensitivity: 'public', expiry: 'never', aliases: ['說'] },
  { key: 'language[].reading', label: '讀', type: 'enum', repeatable: true,
    enum: ['精通', '中等', '略懂'], sensitivity: 'public', expiry: 'never', aliases: ['讀'] },
  { key: 'language[].writing', label: '寫', type: 'enum', repeatable: true,
    enum: ['精通', '中等', '略懂'], sensitivity: 'public', expiry: 'never', aliases: ['寫'] },
  { key: 'language[].test', label: '語言檢定', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'explicit',
    aliases: ['語言檢定', '檢定名稱', '英文檢定'],
    note: '多益成績兩年後失效，走 explicit' },
  { key: 'language[].score', label: '檢定分數', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'explicit', aliases: ['分數', '語言成績', '級數'] },

  { key: 'cert[].name', label: '證照名稱', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['證照名稱', '證照', '專業證照', '技術士證'] },
  { key: 'cert[].issuer', label: '發證單位', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['發證單位', '核發機構'] },
  { key: 'cert[].issued_at', label: '發證日期', type: 'date', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['發證日期', '取得日期'] },
  { key: 'cert[].expires_at', label: '證照到期日', type: 'date', repeatable: true,
    sensitivity: 'public', expiry: 'explicit', aliases: ['到期日', '有效期限'],
    note: '這一欄本身就是 expiresAt 的來源。快到期要進每日簡報。' },
]

// ──────────────────────────────────────────────────────────────
// 八、作品
// ──────────────────────────────────────────────────────────────
const PORTFOLIO: FactKeyDef[] = [
  { key: 'portfolio[].title', label: '作品名稱', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['作品名稱', '專案名稱', '作品'] },
  { key: 'portfolio[].url', label: '作品連結', type: 'url', repeatable: true,
    sensitivity: 'public', expiry: 'months:12',
    aliases: ['作品連結', '專案連結', '作品網址', 'GitHub'],
    note: '連結會死掉，一年檢查一次。autocomplete="url" 讓給 person.website：表單上單獨一個網址欄，通常是要個人首頁。' },
  { key: 'portfolio[].role', label: '擔任角色', type: 'string', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['擔任角色', '負責部分'] },
  { key: 'portfolio[].description', label: '作品說明', type: 'text', repeatable: true,
    sensitivity: 'public', expiry: 'never', aliases: ['作品說明', '專案說明'] },
]

// ──────────────────────────────────────────────────────────────
// 九、求職條件 —— 機會配對的另一半，不是履歷欄位
// ──────────────────────────────────────────────────────────────
const PREFERENCE: FactKeyDef[] = [
  { key: 'preference.job_titles', label: '希望職稱', type: 'string',
    sensitivity: 'normal', expiry: 'months:6',
    aliases: ['希望職稱', '應徵職務', '期望職位'] },
  { key: 'preference.industries', label: '希望產業', type: 'string',
    sensitivity: 'normal', expiry: 'months:6', aliases: ['希望產業', '期望產業'] },
  { key: 'preference.locations', label: '希望工作地點', type: 'string',
    sensitivity: 'normal', expiry: 'months:6',
    aliases: ['希望工作地點', '期望工作地', '上班地點'] },
  { key: 'preference.salary_min', label: '希望待遇', type: 'string',
    sensitivity: 'sensitive', expiry: 'months:6',
    aliases: ['希望待遇', '期望薪資', '希望薪資'] },
  { key: 'preference.employment_type', label: '工作性質', type: 'enum',
    enum: ['全職', '兼職', '接案', '實習', '約聘'],
    sensitivity: 'normal', expiry: 'months:6', aliases: ['工作性質', '職務類型'] },
  { key: 'preference.availability', label: '可上班日', type: 'string',
    sensitivity: 'normal', expiry: 'months:6',
    aliases: ['可上班日', '到職日', '最快到職'],
    note: '「一個月內」這種值一定會爛掉' },
  { key: 'preference.remote', label: '遠端意願', type: 'enum',
    enum: ['只要遠端', '可遠端', '可混合', '只要實體'],
    sensitivity: 'normal', expiry: 'months:6', aliases: ['遠端', '遠距工作'] },
]

// ──────────────────────────────────────────────────────────────
// 十、長文與推薦人
// ──────────────────────────────────────────────────────────────
const WRITING: FactKeyDef[] = [
  { key: 'writing.autobiography', label: '自傳', type: 'text',
    sensitivity: 'public', expiry: 'months:12',
    aliases: ['自傳', '個人簡介', '自我介紹', '簡歷', '個人描述', '關於我'],
    note: '這是生成物不是事實：source.kind = derived。改過履歷就該重生成，所以有效期一年。' },

  { key: 'writing.cover_letter', label: '求職信', type: 'text',
    sensitivity: 'public', expiry: 'months:6',
    aliases: ['求職信', '應徵動機', '求職動機', '應徵原因'],
    note: '每份工作都不一樣，不該重用。存的是最近一次的版本。' },
]

const REFERENCE: FactKeyDef[] = [
  { key: 'reference[].name', label: '推薦人姓名', type: 'string', repeatable: true,
    sensitivity: 'sensitive', expiry: 'months:12',
    aliases: ['推薦人', '推薦人姓名', '介紹人'],
    note: '別人的個資，跟緊急聯絡人同一級。' },
  { key: 'reference[].title', label: '推薦人職稱', type: 'string', repeatable: true,
    sensitivity: 'sensitive', expiry: 'months:12', aliases: ['推薦人職稱', '推薦人服務單位'] },
  { key: 'reference[].contact', label: '推薦人聯絡方式', type: 'string', repeatable: true,
    sensitivity: 'sensitive', expiry: 'months:12', aliases: ['推薦人聯絡方式', '推薦人電話'] },
]

export const FACT_KEYS: FactKeyDef[] = [
  ...PERSON, ...IDENTITY, ...CONTACT, ...EMERGENCY,
  ...EDUCATION, ...WORK, ...ABILITY, ...PORTFOLIO, ...PREFERENCE,
  ...WRITING, ...REFERENCE,
]

// ──────────────────────────────────────────────────────────────
// 查表工具 —— 邏輯在 match.js，那一支擴充套件也共用，只有一份
// ──────────────────────────────────────────────────────────────
import { buildIndex } from './match.js'

const M = buildIndex(FACT_KEYS)

/** 第 1 層：讀 input 的 autocomplete 屬性 */
export const matchByAutocomplete = (token?: string | null): FactKeyDef | null =>
  M.matchByAutocomplete(token)

/** 第 2 層：拿 label / name / placeholder 的文字去比對 */
export const matchByLabel = (text?: string | null): FactKeyDef | null =>
  M.matchByLabel(text)

export const defOf = (key: string): FactKeyDef | null => M.defOf(key)

/** 查不到就當最敏感，不是當公開 */
export const sensitivityOf = (key: string): Sensitivity => M.sensitivityOf(key)

/** 擴充套件能不能不問就填 */
export const canAutofill = (key: string): boolean => M.canAutofill(key)

/** 這個 key 該怎麼填 */
export const fillOf = (key: string): FillMode | null => {
  const d = defOf(key)
  return d ? fillModeOf(d) : null
}

/**
 * 擴充套件到底能不能「碰都不用問就填下去」。
 * 三個條件都要過：值是確定的、不敏感、而且我們手上真的有那筆事實。
 */
export const canFillSilently = (key: string): boolean =>
  fillOf(key) === 'direct' && canAutofill(key)
