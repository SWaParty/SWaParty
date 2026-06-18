export default {
  email: {
    verify: {
      subject: '验证你的 SWaParty 账户',
      title: 'SWaParty - 验证你的邮箱',
      intro: '请点击下方按钮完成注册。',
      cta: '验证邮箱',
      ttl: '该链接 30 分钟内有效。',
      ignore: '如果这不是你的操作，请忽略此邮件。',
    },
    changeCode: {
      subject: 'SWaParty 邮箱变更验证码',
      title: 'SWaParty - 验证新的登录邮箱',
      intro: '你的邮箱变更验证码是：',
      ttl: '该验证码 10 分钟内有效。',
      ignore: '如果这不是你的操作，请忽略此邮件。',
    },
    reset: {
      subject: 'SWaParty 重置密码验证码',
      title: 'SWaParty - 重置你的密码',
      intro: '你的验证码是：',
      ttl: '该验证码 10 分钟内有效。',
      ignore: '如果这不是你的操作，请忽略此邮件。',
    },
  },
  contacts: {
    inviteReceived: '{senderName} 向你发送了联系人邀请。',
    inviteRejectedByReceiver: '{senderName} 已拒绝你的联系人邀请。',
    inviteCanceledByReceiver: '{senderName} 已取消你们之间的邀请流程，你可以再次发起邀请。',
    contactRemovedByPeer: '{senderName} 已将你从联系人中移除。',
    contactRemovedByAccountDeleted: '{senderName} 已注销账号，系统已为你自动解除与 {senderName} 的联系人关系。',
  },
  rooms: {
    defaultRoomTitle: '同步观影厅',
    inviteMessageReceived: '{senderName} 邀请你加入「{title}」· 房间 {roomHash} · {count}/{max} 在线',
    watchRequestMessage: '{senderName} 邀请你一同观影，将在 {senderName} 第一次创建房间时通知你',
  },
};
