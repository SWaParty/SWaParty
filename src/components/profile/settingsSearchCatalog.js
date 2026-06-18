const SEARCH_ALIAS_GROUPS = [
  [
    '名字', '名稱', '昵称', '暱稱', '显示昵称', '顯示暱稱', '显示名称', '顯示名稱',
    '用户名', '使用者名稱', '称呼', '稱呼', '网名', '網名', 'id 名称', 'id 名稱',
    'name', 'display name', 'profile name', 'nickname', 'handle',
    'ニックネーム', '表示名', '名前',
    '닉네임', '표시 이름', '이름',
  ],
  [
    '邮箱', '郵箱', '邮件', '郵件', '电子邮箱', '電子郵箱', '邮箱地址', '郵箱地址',
    '信箱', '邮件地址', '郵件地址', '账号邮箱', '帳號信箱',
    'email', 'mail', 'e-mail', 'email address', 'account email',
    'メール', 'メールアドレス', 'メアド',
    '이메일', '메일', '메일주소', '이메일 주소',
  ],
  [
    '语言', '語言', '语言设置', '語言設定', '切换语言', '切換語言', '翻译', '翻譯',
    'language', 'locale', 'language setting', 'language settings',
    '言語', '言語設定', '表示言語',
    '언어', '언어 설정', '표시 언어', '로케일',
  ],
  [
    '云端空间', '雲端空間', '云盘', '雲盤', '云空间', '雲空間', '存储', '儲存', '容量',
    '可用空间', '可用空間', '剩余空间', '剩餘空間', '储存空间', '儲存空間',
    'cloud', 'cloud storage', 'storage', 'space', 'capacity', 'free space', 'used space',
    'クラウド', 'クラウド保存', 'ストレージ', '保存容量', '容量',
    '클라우드', '클라우드 저장소', '저장공간', '저장 용량', '남은 용량',
  ],
  [
    '密码', '密碼', '密码修改', '密碼修改', '改密码', '改密碼', '登录密码', '登入密碼',
    'password', 'password change', 'change password', 'credential', 'security',
    'パスワード', 'パスワード変更', 'ログインパスワード',
    '비밀번호', '비밀번호 변경', '로그인 비밀번호', '암호', '보안',
  ],
  [
    '2fa', 'two-factor', 'two factor', 'two-step verification', 'mfa', 'totp', 'otp',
    '双重验证', '雙重驗證', '两步验证', '兩步驗證', '二步验证', '二步驗證', '动态码', '動態碼',
    '验证器', '驗證器', '身份验证器', '身分驗證器',
    '二段階認証', '2段階認証', '認証アプリ', 'ワンタイムコード',
    '2단계 인증', '이중 인증', '인증 앱', '일회용 코드',
  ],
  [
    '备用码', '備用碼', '备份码', '備份碼', '恢复码', '恢復碼', '验证码', '驗證碼', '救援码', '救援碼',
    'backup', 'backup code', 'recovery code', 'recovery',
    'バックアップコード', '復旧コード', 'リカバリーコード',
    '백업 코드', '복구 코드', '리커버리 코드',
  ],
  [
    '硬件加速', '硬體加速', 'gpu', '显卡加速', '顯卡加速', '渲染加速',
    'hardware acceleration', 'gpu acceleration', 'render',
    'ハードウェアアクセラレーション', 'gpu 加速', '描画高速化',
    '하드웨어 가속', 'gpu 가속', '렌더링 가속',
  ],
  [
    '播放控制', '播放权限', '播放權限', '控制权限', '控制權限', '房间控制', '房間控制',
    'playback control', 'control', 'permission', 'room control',
    '再生制御', '再生コントロール', '操作権限',
    '재생 제어', '재생 권한', '방 제어',
  ],
  [
    '入场提示音', '入場提示音', '提示音', '提醒音', '音效', '进房提示音', '進房提示音',
    'entry sound', 'join sound', 'notification sound', 'sound effect',
    '入場音', '通知音', '参加音',
    '입장 알림음', '알림음', '입장 효과음',
  ],
  [
    '自动重同步', '自動重同步', '重同步', '自动校准', '自動校準', '同步策略',
    'auto resync', 'resync', 'sync strategy', 'playback drift',
    '再同期', '自動再同期', '同期戦略',
    '자동 재동기화', '동기화 전략',
  ],
  [
    '时间偏差阈值', '時間偏差閾值', '误差阈值', '誤差閾值', '时间误差', '時間誤差',
    'threshold', 'drift threshold', 'time drift', 'sync threshold',
    'しきい値', '時間ずれ',
    '임계값', '시간 오차',
  ],
  [
    '入房自动追帧', '入房自動追幀', '追帧', '追幀', '加入自动对齐', '快速对齐',
    'catch up', 'auto catch-up', 'join catch-up',
    '自動追従', '入室時追従',
    '자동 따라가기', '입장 동기화',
  ],
  [
    '消息提示音', '訊息提示音', '聊天提示音', '聊天提示音效', '通知铃声',
    'message sound', 'chat sound', 'message notification',
    'メッセージ通知音', '通知サウンド',
    '메시지 알림음', '채팅 알림음',
  ],
  [
    '消息展示过滤', '訊息展示過濾', '消息过滤', '訊息過濾', '只看聊天',
    'message filter', 'display filter', 'chat filter', 'chat only',
    '表示フィルター',
    '표시 필터', '채팅만',
  ],
  [
    '记录', '記錄', '历史', '歷史', '邀请', '邀請', '邀请记录', '邀請記錄', '邀请历史', '邀請歷史',
    '联系人记录', '聯絡人記錄', 'quick contacts', 'contacts', 'history', 'record', 'records',
    'invite', 'invites', 'invitation', 'invite history',
    '履歴', '招待', '招待履歴', '連絡先履歴',
    '기록', '초대', '초대 기록', '연락처 기록',
  ],
];

const SEARCH_ALIAS_MAP = SEARCH_ALIAS_GROUPS.reduce((acc, group) => {
  const normalized = group.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  normalized.forEach((term) => {
    acc[term] = normalized.filter((candidate) => candidate !== term);
  });
  return acc;
}, {});

export function resolveSettingsSearchTerms(input) {
  const query = String(input || '').trim().toLowerCase();
  if (!query) return [];
  const terms = new Set([query]);
  const aliasList = SEARCH_ALIAS_MAP[query] || [];
  aliasList.forEach((item) => terms.add(String(item).toLowerCase()));
  return Array.from(terms);
}

export function buildSettingsSearchCatalog(t) {
  return [
    {
      id: 'display_name',
      tab: 'profile',
      title: t('profile.labelDisplayName'),
      desc: t('profile.searchDescDisplayName'),
      keywords: ['display', 'name', 'nickname', '昵称', '名字', '显示名称', '用户名'],
    },
    {
      id: 'email',
      tab: 'profile',
      title: t('profile.labelLoginEmail'),
      desc: t('profile.searchDescLoginEmail'),
      keywords: ['email', 'mail', 'account', '邮箱', '邮件', '账号'],
    },
    {
      id: 'language',
      tab: 'profile',
      title: t('profile.labelLanguage'),
      desc: t('profile.searchDescLanguage'),
      keywords: ['language', 'locale', 'translate', '语言', '翻译'],
    },
    {
      id: 'cloud_storage',
      tab: 'profile',
      title: t('profile.cloudStorage'),
      desc: t('profile.searchDescCloudStorage'),
      keywords: ['storage', 'cloud', 'space', 'capacity', '云盘', '云端空间', '存储', '容量'],
    },
    {
      id: 'password',
      tab: 'security',
      title: t('profile.password'),
      desc: t('profile.searchDescPassword'),
      keywords: ['password', 'security', 'credential', '密码', '安全'],
    },
    {
      id: 'two_factor',
      tab: 'security',
      title: t('profile.twoFactorAuth'),
      desc: t('profile.twoFactorAuthDesc'),
      keywords: ['2fa', 'totp', 'verification', '验证器', '双重验证', '二步验证'],
    },
    {
      id: 'backup_codes',
      tab: 'security',
      title: t('profile.backupCodesTitle'),
      desc: t('profile.backupCodesDesc'),
      keywords: ['backup', 'recovery', 'codes', '备用码', '恢复码', '验证码'],
    },
    {
      id: 'hardware_acceleration',
      tab: 'preferences',
      title: t('profile.hardwareAcceleration'),
      desc: t('profile.hardwareAccelerationDesc'),
      keywords: ['gpu', 'hardware', 'acceleration', 'render', '硬件加速'],
    },
    {
      id: 'allow_control',
      tab: 'preferences',
      title: t('profile.allowControl'),
      desc: t('profile.allowControlDesc'),
      keywords: ['control', 'playback', 'permission', '播放控制', '权限'],
    },
    {
      id: 'join_sound',
      tab: 'preferences',
      title: t('profile.joinSound'),
      desc: t('profile.joinSoundDesc'),
      keywords: ['sound', 'entry', 'notification', '提示音', '入场音效'],
    },
    {
      id: 'auto_resync',
      tab: 'preferences',
      title: t('profile.autoResync'),
      desc: t('profile.autoResyncDesc'),
      keywords: ['resync', 'sync', 'drift', '自动重同步', '同步策略'],
    },
    {
      id: 'sync_threshold',
      tab: 'preferences',
      title: t('profile.syncThreshold'),
      desc: t('profile.syncThresholdDesc'),
      keywords: ['threshold', 'drift', 'time', '时间偏差', '误差阈值'],
    },
    {
      id: 'auto_catch_up_on_join',
      tab: 'preferences',
      title: t('profile.autoCatchUpOnJoin'),
      desc: t('profile.autoCatchUpOnJoinDesc'),
      keywords: ['catch up', 'join', 'sync', '追帧', '入房自动追帧'],
    },
    {
      id: 'message_notification_sound',
      tab: 'preferences',
      title: t('profile.messageNotificationSound'),
      desc: t('profile.messageNotificationSoundDesc'),
      keywords: ['message sound', 'chat sound', '消息提示音', '聊天提示音'],
    },
    {
      id: 'message_display_filter',
      tab: 'preferences',
      title: t('profile.messageDisplayFilter'),
      desc: t('profile.messageDisplayFilterDesc'),
      keywords: ['filter', 'message type', 'chat', '消息过滤', '展示过滤', '只看聊天'],
    },
    {
      id: 'quick_contacts',
      tab: 'contacts',
      title: t('profile.sectionQuickContacts'),
      desc: t('profile.quickContactsHistoryAction'),
      keywords: ['contacts', 'quick contacts', '联系人', '快捷联系人', '联系记录', '記錄', '记录', 'history'],
    },
    {
      id: 'invite_history',
      tab: 'contacts',
      title: t('profile.inviteHistoryTitle'),
      desc: t('profile.quickContactsSendInvite'),
      keywords: ['invite', 'invitation', 'invite history', 'history', '邀请', '邀請', '邀请记录', '邀请历史', '记录'],
    },
  ];
}
