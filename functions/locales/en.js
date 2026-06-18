export default {
  email: {
    verify: {
      subject: 'Verify your SWaParty account',
      title: 'SWaParty - Verify your email',
      intro: 'Click the button below to finish registration.',
      cta: 'Verify Email',
      ttl: 'This link is valid for 30 minutes.',
      ignore: 'If you did not create this account, ignore this email.',
    },
    changeCode: {
      subject: 'SWaParty Email Change Verification Code',
      title: 'SWaParty - Verify your new email',
      intro: 'Your email change verification code is:',
      ttl: 'This code is valid for 10 minutes.',
      ignore: 'If you did not request an email change, ignore this email.',
    },
    reset: {
      subject: 'SWaParty Password Reset Code',
      title: 'SWaParty - Reset your password',
      intro: 'Your verification code is:',
      ttl: 'This code is valid for 10 minutes.',
      ignore: 'If you did not request this, please ignore this email.',
    },
  },
  contacts: {
    inviteReceived: '{senderName} sent you a contact invite.',
    inviteRejectedByReceiver: '{senderName} declined your contact invite.',
    inviteCanceledByReceiver: '{senderName} canceled your pending invite, you can send a new invite again.',
    contactRemovedByPeer: '{senderName} removed you from contacts.',
    contactRemovedByAccountDeleted: '{senderName} deleted the account. The contact relationship with {senderName} was removed automatically.',
  },
  rooms: {
    defaultRoomTitle: 'Sync Watch Room',
    inviteMessageReceived: '{senderName} invited you to join {title} · Room {roomHash} · {count}/{max} online',
    watchRequestMessage: '{senderName} invited you to watch together. You will be notified when {senderName} creates a room for the first time.',
  },
};
