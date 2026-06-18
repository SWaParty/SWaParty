export default {
  email: {
    verify: {
      subject: 'SWaParty 계정 이메일 인증',
      title: 'SWaParty - 이메일을 인증해 주세요',
      intro: '아래 버튼을 눌러 회원가입을 완료하세요.',
      cta: '이메일 인증',
      ttl: '이 링크는 30분 동안 유효합니다.',
      ignore: '요청한 적이 없다면 이 메일을 무시하세요.',
    },
    changeCode: {
      subject: 'SWaParty 이메일 변경 인증코드',
      title: 'SWaParty - 새 로그인 이메일 인증',
      intro: '이메일 변경 인증코드입니다:',
      ttl: '이 코드는 10분 동안 유효합니다.',
      ignore: '요청한 적이 없다면 이 메일을 무시하세요.',
    },
    reset: {
      subject: 'SWaParty 비밀번호 재설정 코드',
      title: 'SWaParty - 비밀번호 재설정',
      intro: '인증코드는 다음과 같습니다:',
      ttl: '이 코드는 10분 동안 유효합니다.',
      ignore: '요청한 적이 없다면 이 메일을 무시하세요.',
    },
  },
  contacts: {
    inviteReceived: '{senderName}님이 연락처 초대를 보냈습니다.',
    inviteRejectedByReceiver: '{senderName}님이 회원님의 연락처 초대를 거절했습니다.',
    inviteCanceledByReceiver: '{senderName}님이 진행 중인 초대를 취소했습니다, 다시 초대를 보낼 수 있습니다.',
    contactRemovedByPeer: '{senderName}님이 회원님을 연락처에서 삭제했습니다.',
    contactRemovedByAccountDeleted: '{senderName}님이 계정을 삭제하여 {senderName}님과의 연락처 관계가 자동으로 해제되었습니다.',
  },
  rooms: {
    defaultRoomTitle: '동시 시청방',
    inviteMessageReceived: '{senderName}님이 {title} 방에 초대했습니다 · 방 {roomHash} · {count}/{max} 온라인',
    watchRequestMessage: '{senderName}님이 함께 시청하도록 초대했습니다. {senderName}님이 처음 방을 만들 때 알림을 받습니다.',
  },
};
