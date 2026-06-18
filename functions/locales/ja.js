export default {
  email: {
    verify: {
      subject: 'SWaParty アカウントのメール確認',
      title: 'SWaParty - メールアドレスを確認してください',
      intro: '下のボタンをクリックして登録を完了してください。',
      cta: 'メールを確認',
      ttl: 'このリンクは30分間有効です。',
      ignore: '心当たりがない場合はこのメールを無視してください。',
    },
    changeCode: {
      subject: 'SWaParty メール変更認証コード',
      title: 'SWaParty - 新しいログインメールを認証',
      intro: 'あなたのメール変更認証コードです：',
      ttl: 'このコードは10分間有効です。',
      ignore: '心当たりがない場合はこのメールを無視してください。',
    },
    reset: {
      subject: 'SWaParty パスワード再設定コード',
      title: 'SWaParty - パスワードを再設定',
      intro: 'あなたの認証コードは：',
      ttl: 'このコードは10分間有効です。',
      ignore: '心当たりがない場合はこのメールを無視してください。',
    },
  },
  contacts: {
    inviteReceived: '{senderName} さんから連絡先招待が届きました。',
    inviteRejectedByReceiver: '{senderName} さんがあなたの連絡先招待を拒否しました。',
    inviteCanceledByReceiver: '{senderName} さんが進行中の招待をキャンセルしました、あらためて招待を送ることができます。',
    contactRemovedByPeer: '{senderName} さんに連絡先から削除されました。',
    contactRemovedByAccountDeleted: '{senderName} さんがアカウントを削除したため、{senderName} さんとの連絡先関係は自動で解除されました。',
  },
  rooms: {
    defaultRoomTitle: '同期視聴ルーム',
    inviteMessageReceived: '{senderName} が {title} に招待しました · ルーム {roomHash} · {count}/{max} オンライン',
    watchRequestMessage: '{senderName} が一緒に視聴するよう招待しました。{senderName} が初めてルームを作成したときに通知されます。',
  },
};
