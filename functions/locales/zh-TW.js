export default {
  email: {
    verify: {
      subject: '驗證你的 SWaParty 帳戶',
      title: 'SWaParty - 驗證你的信箱',
      intro: '請點擊下方按鈕完成註冊。',
      cta: '驗證信箱',
      ttl: '此連結於 30 分鐘內有效。',
      ignore: '如果這不是你的操作，請忽略此郵件。',
    },
    changeCode: {
      subject: 'SWaParty 信箱變更驗證碼',
      title: 'SWaParty - 驗證新的登入信箱',
      intro: '你的信箱變更驗證碼是：',
      ttl: '此驗證碼於 10 分鐘內有效。',
      ignore: '如果這不是你的操作，請忽略此郵件。',
    },
    reset: {
      subject: 'SWaParty 重設密碼驗證碼',
      title: 'SWaParty - 重設你的密碼',
      intro: '你的驗證碼是：',
      ttl: '此驗證碼於 10 分鐘內有效。',
      ignore: '如果這不是你的操作，請忽略此郵件。',
    },
  },
  contacts: {
    inviteReceived: '{senderName} 向你發送了聯絡人邀請。',
    inviteRejectedByReceiver: '{senderName} 已拒絕你的聯絡人邀請。',
    inviteCanceledByReceiver: '{senderName} 已取消你們之間的邀請流程，你可以再次發起邀請。',
    contactRemovedByPeer: '{senderName} 已將你從聯絡人中移除。',
    contactRemovedByAccountDeleted: '{senderName} 已註銷帳號，系統已為你自動解除與 {senderName} 的聯絡人關係。',
  },
  rooms: {
    defaultRoomTitle: '同步觀影廳',
    inviteMessageReceived: '{senderName} 邀請你加入「{title}」· 房間 {roomHash} · {count}/{max} 在線',
    watchRequestMessage: '{senderName} 邀請你一同觀影，將在 {senderName} 第一次建立房間時通知你',
  },
};
