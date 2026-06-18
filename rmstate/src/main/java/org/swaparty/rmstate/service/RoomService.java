package org.swaparty.rmstate.service;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.swaparty.rmstate.config.AppProperties;
import org.swaparty.rmstate.model.InternalUser;
import org.swaparty.rmstate.model.RoomDtos.ActivityLogView;
import org.swaparty.rmstate.model.RoomDtos.CreateRoomRequest;
import org.swaparty.rmstate.model.RoomDtos.JoinRoomRequest;
import org.swaparty.rmstate.model.RoomDtos.MemberView;
import org.swaparty.rmstate.model.RoomDtos.MessageRequest;
import org.swaparty.rmstate.model.RoomDtos.MessageView;
import org.swaparty.rmstate.model.RoomDtos.MountMediaRequest;
import org.swaparty.rmstate.model.RoomDtos.PlaybackRequest;
import org.swaparty.rmstate.model.RoomDtos.PlaybackView;
import org.swaparty.rmstate.model.RoomDtos.RoomSnapshot;
import org.swaparty.rmstate.model.RoomDtos.RoomView;
import org.swaparty.rmstate.realtime.RealtimePublisher;
import org.swaparty.rmstate.web.RoomHttpException;

@Service
public class RoomService {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final char[] HASH_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();
  private static final int DEFAULT_LOG_LIMIT = 30;
  private static final int DEFAULT_MESSAGE_LIMIT = 200;
  private static final long MEMBER_SESSION_STALE_SECONDS = 70;
  private static final String STATUS_OPEN = "open";
  private static final String STATUS_HOST_DISCONNECTED = "host_disconnected";
  private final JdbcTemplate jdbc;
  private final RealtimePublisher realtimePublisher;
  private final AppProperties appProperties;

  public RoomService(JdbcTemplate jdbc, RealtimePublisher realtimePublisher, AppProperties appProperties) {
    this.jdbc = jdbc;
    this.realtimePublisher = realtimePublisher;
    this.appProperties = appProperties;
  }

  @Transactional
  public RoomSnapshot createRoom(CreateRoomRequest request, InternalUser user, String clientId) {
    RoomRecord existingHostRoom = findLiveHostRoomForUpdate(user.userId());
    if (existingHostRoom != null) {
      long now = nowSec();
      jdbc.update("""
          UPDATE rooms
          SET status = 'open',
              host_last_seen_at = ?,
              host_disconnected_at = NULL,
              expires_at = NULL
          WHERE id = ?
          """, now, existingHostRoom.id());
      ensureActiveMember(existingHostRoom.id(), user, "host", now);
      touchMemberSession(existingHostRoom.id(), user.userId(), clientId, now);
      insertLog(existingHostRoom.id(), user.userId(), "room.reconnected", "{}", now);
      RoomSnapshot snapshot = loadSnapshot(existingHostRoom.id());
      publish(existingHostRoom.hash(), "room.host.reconnected", targetsForRoom(existingHostRoom.id()),
          Map.of("roomHash", existingHostRoom.hash(), "room", snapshot.room()));
      return snapshot;
    }

    long now = nowSec();
    UUID roomId = UUID.randomUUID();
    String hash = createUniqueRoomHash();
    String title = normalize(request.title(), "SWaParty Room", 160);
    String notice = normalizeNullable(request.notice(), 4000);
    int maxMembers = clamp(request.maxMembers() == null ? 8 : request.maxMembers(), 2, 99);
    boolean hostOnlyControl = request.hostOnlyControl() == null || request.hostOnlyControl();
    boolean allowChat = request.allowChat() == null || request.allowChat();

    try {
      jdbc.update("""
          INSERT INTO rooms
            (id, hash, title, notice, host_user_id, status, max_members, host_only_control, allow_chat,
             created_at, host_last_seen_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
          """, roomId, hash, title, notice, user.userId(), maxMembers, hostOnlyControl, allowChat, now, now);
    } catch (DuplicateKeyException ex) {
      RoomRecord racedHostRoom = findLiveHostRoomForUpdate(user.userId());
      if (racedHostRoom != null) return loadSnapshot(racedHostRoom.id());
      throw new RoomHttpException(HttpStatus.CONFLICT, "active_host_room_exists");
    }

    insertMember(roomId, user, "host", now);
    touchMemberSession(roomId, user.userId(), clientId, now);
    jdbc.update("""
        INSERT INTO room_playback_state
          (room_id, current_time_sec, paused, playback_rate, revision, updated_by, updated_at)
        VALUES (?, 0, TRUE, 1, 0, ?, ?)
        """, roomId, user.userId(), now);
    insertLog(roomId, user.userId(), "room.created", jsonPair("hash", hash), now);

    RoomSnapshot snapshot = getSnapshot(hash, user);
    publish(hash, "room.created", targetsForRoom(roomId), Map.of("roomHash", hash, "room", snapshot.room()));
    return snapshot;
  }

  @Transactional
  public RoomSnapshot joinRoom(String hash, JoinRoomRequest request, InternalUser user, String clientId) {
    RoomRecord room = requireLiveRoomForUpdate(hash);
    boolean knownMember = isKnownMember(room.id(), user.userId());
    if (STATUS_HOST_DISCONNECTED.equals(room.status()) && !knownMember) {
      throw new RoomHttpException(HttpStatus.CONFLICT, "room_suspended");
    }

    RoomRecord hostedRoom = findLiveHostRoomForUpdate(user.userId());
    if (hostedRoom != null && !hostedRoom.id().equals(room.id())) {
      if (request == null || !Boolean.TRUE.equals(request.dismissHostedRoom())) {
        throw new RoomHttpException(HttpStatus.CONFLICT, "active_host_room_exists");
      }
      dismissRoomRecord(hostedRoom, user.userId(), "room.dismissed.by_join_override");
    }

    int activeCount = jdbc.queryForObject(
        "SELECT COUNT(*) FROM room_members WHERE room_id = ? AND status = 'active'",
        Integer.class,
        room.id());
    if (activeCount >= room.maxMembers() && !isActiveMember(room.id(), user.userId())) {
      throw new RoomHttpException(HttpStatus.CONFLICT, "room_full");
    }

    long now = nowSec();
    if (knownMember) {
      jdbc.update("""
          UPDATE room_members
          SET status = 'active', removed_at = NULL, display_name_snapshot = ?, avatar_url_snapshot = ?
          WHERE room_id = ? AND user_id = ?
          """, user.safeDisplayName(), trimToNull(user.avatarUrl()), room.id(), user.userId());
    } else {
      insertMember(room.id(), user, "member", now);
    }
    touchMemberSession(room.id(), user.userId(), clientId, now);
    insertLog(room.id(), user.userId(), "member.joined", "{}", now);

    RoomSnapshot snapshot = getSnapshot(hash, user);
    publish(hash, "room.member.joined", targetsForRoom(room.id()),
        Map.of("roomHash", hash, "member", memberForUser(room.id(), user.userId())));
    return snapshot;
  }

  @Transactional(readOnly = true)
  public RoomSnapshot getSnapshot(String hash, InternalUser user) {
    RoomRecord room = requireRoom(hash);
    if (!isActiveMember(room.id(), user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "not_room_member");
    }
    return loadSnapshot(room.id());
  }

  @Transactional
  public List<RoomSnapshot> activeRooms(InternalUser user) {
    suspendStaleHostedRoom(user.userId());
    return jdbc.query("""
        SELECT r.id
        FROM rooms r
        JOIN room_members m ON m.room_id = r.id
        WHERE m.user_id = ?
          AND m.status = 'active'
          AND r.status IN ('open', 'host_disconnected')
        ORDER BY r.created_at DESC
        LIMIT 10
        """, (rs, rowNum) -> UUID.fromString(rs.getString("id")), user.userId())
        .stream()
        .map(this::loadSnapshot)
        .toList();
  }

  @Transactional
  public RoomSnapshot closeRoom(String hash, InternalUser user) {
    return dismissRoom(hash, user);
  }

  @Transactional
  public RoomSnapshot dismissRoom(String hash, InternalUser user) {
    RoomRecord room = requireLiveRoomForUpdate(hash);
    requireHost(room, user);
    dismissRoomRecord(room, user.userId(), "room.dismissed");
    return loadSnapshot(room.id());
  }

  @Transactional
  public RoomSnapshot leaveRoom(String hash, InternalUser user, String clientId) {
    RoomRecord room = requireLiveRoomForUpdate(hash);
    long now = nowSec();
    markMemberSessionLeft(room.id(), user.userId(), clientId, now);
    boolean hasAnotherActiveSession = hasActiveMemberSession(room.id(), user.userId(), now);
    if (room.hostUserId().equals(user.userId())) {
      if (!hasAnotherActiveSession) {
        suspendHost(room, user.userId(), now, "room.host.disconnected");
      }
    } else if (isActiveMember(room.id(), user.userId())) {
      if (!hasAnotherActiveSession) {
        jdbc.update("""
            UPDATE room_members
            SET status = 'left', removed_at = ?
            WHERE room_id = ? AND user_id = ?
            """, now, room.id(), user.userId());
        insertLog(room.id(), user.userId(), "member.left", "{}", now);
        publish(room.hash(), "room.member.left", targetsForRoom(room.id()),
            Map.of("roomHash", room.hash(), "userId", user.userId()));
      }
    }
    return loadSnapshot(room.id());
  }

  @Transactional
  public RoomSnapshot heartbeatRoom(String hash, InternalUser user, String clientId) {
    RoomRecord room = requireLiveRoomForUpdate(hash);
    long now = nowSec();
    if (!room.hostUserId().equals(user.userId())) {
      if (!isActiveMember(room.id(), user.userId())) {
        throw new RoomHttpException(HttpStatus.FORBIDDEN, "not_room_member");
      }
      touchMemberSession(room.id(), user.userId(), clientId, now);
      return loadSnapshot(room.id());
    }

    jdbc.update("""
        UPDATE rooms
        SET status = 'open',
            host_last_seen_at = ?,
            host_disconnected_at = NULL,
            expires_at = NULL
        WHERE id = ?
        """, now, room.id());
    ensureActiveMember(room.id(), user, "host", now);
    touchMemberSession(room.id(), user.userId(), clientId, now);
    if (STATUS_HOST_DISCONNECTED.equals(room.status())) {
      insertLog(room.id(), user.userId(), "room.host.reconnected", "{}", now);
      publish(room.hash(), "room.host.reconnected", targetsForRoom(room.id()),
          Map.of("roomHash", room.hash(), "reconnectedAt", now));
    }
    return loadSnapshot(room.id());
  }

  @Transactional
  public PlaybackView mountMedia(String hash, MountMediaRequest request, InternalUser user) {
    RoomRecord room = requireOpenRoomForUpdate(hash);
    requireControl(room, user);
    long now = nowSec();
    String mediaKey = normalize(request.mediaKey(), "cloud:" + request.mediaId(), 2048);
    String sourceType = normalize(request.sourceType(), "cloud_media", 32);

    jdbc.update("""
        UPDATE room_playback_state
        SET media_id = ?,
            media_key = ?,
            media_title_snapshot = ?,
            media_duration_sec = ?,
            source_type = ?,
            current_time_sec = 0,
            paused = TRUE,
            playback_rate = 1,
            revision = revision + 1,
            updated_by = ?,
            updated_at = ?
        WHERE room_id = ?
        """,
        request.mediaId(),
        mediaKey,
        normalize(request.mediaTitle(), "Untitled video", 240),
        safeNonNegative(request.durationSec()),
        sourceType,
        user.userId(),
        now,
        room.id());

    PlaybackView playback = playbackForRoom(room.id());
    insertLog(room.id(), user.userId(), "media.changed", jsonPair("mediaId", request.mediaId()), now);
    publish(hash, "room.media.changed", targetsForRoom(room.id()),
        Map.of("roomHash", hash, "playback", playback, "updatedBy", user.userId()));
    return playback;
  }

  @Transactional
  public PlaybackView updatePlayback(String hash, PlaybackRequest request, InternalUser user) {
    RoomRecord room = requireOpenRoomForUpdate(hash);
    requireControl(room, user);
    PlaybackView current = playbackForRoom(room.id());
    if (current.mediaId() == null || current.mediaId().isBlank()) {
      throw new RoomHttpException(HttpStatus.CONFLICT, "no_media_mounted");
    }

    String action = normalize(request.action(), "", 24).toLowerCase();
    boolean paused = current.paused();
    double time = current.currentTimeSec();
    double rate = current.playbackRate();
    if ("play".equals(action)) paused = false;
    else if ("pause".equals(action)) paused = true;
    else if ("seek".equals(action)) time = safeNonNegative(request.currentTimeSec());
    else if ("rate".equals(action)) rate = clampDouble(request.playbackRate() == null ? 1 : request.playbackRate(), 0.5, 4.0);
    else throw new RoomHttpException(HttpStatus.BAD_REQUEST, "invalid_playback_action");

    if (request.currentTimeSec() != null && !"seek".equals(action)) {
      time = safeNonNegative(request.currentTimeSec());
    }

    long now = nowSec();
    jdbc.update("""
        UPDATE room_playback_state
        SET current_time_sec = ?,
            paused = ?,
            playback_rate = ?,
            revision = revision + 1,
            updated_by = ?,
            updated_at = ?
        WHERE room_id = ?
        """, time, paused, rate, user.userId(), now, room.id());

    PlaybackView playback = playbackForRoom(room.id());
    insertLog(room.id(), user.userId(), "playback." + action, jsonPair("timeSec", String.valueOf(time)), now);
    publish(hash, "room.playback.updated", targetsForRoom(room.id()),
        Map.of("roomHash", hash, "playback", playback, "revision", playback.revision()));
    return playback;
  }

  @Transactional
  public MessageView createMessage(String hash, MessageRequest request, InternalUser user) {
    RoomRecord room = requireLiveRoomForUpdate(hash);
    if (!isActiveMember(room.id(), user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "not_room_member");
    }
    if (!room.allowChat()) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "chat_disabled");
    }
    PlaybackView playback = playbackForRoom(room.id());

    long now = nowSec();
    UUID id = UUID.randomUUID();
    String kind = normalize(request.kind(), "chat", 24);
    String mediaKey = normalizeNullable(request.mediaKey(), 2048);
    if (mediaKey == null || mediaKey.isBlank()) mediaKey = playback.mediaKey();
    String body = normalize(request.body(), "", 2000);

    jdbc.update("""
        INSERT INTO room_messages
          (id, room_id, media_id, media_key, video_time_sec, sender_user_id, sender_name_snapshot,
           sender_avatar_url_snapshot, body, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        id,
        room.id(),
        normalizeNullable(request.mediaId(), 128),
        mediaKey,
        request.videoTimeSec() == null ? null : safeNonNegative(request.videoTimeSec()),
        user.userId(),
        user.safeDisplayName(),
        trimToNull(user.avatarUrl()),
        body,
        kind,
        now);

    MessageView message = messageById(id);
    publish(hash, "room.message.created", targetsForRoom(room.id()),
        Map.of("roomHash", hash, "message", message));
    return message;
  }

  @Transactional(readOnly = true)
  public List<ActivityLogView> activityLogs(String hash, InternalUser user, int limit) {
    RoomRecord room = requireRoom(hash);
    if (!isActiveMember(room.id(), user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "not_room_member");
    }
    return activityLogsForRoom(room.id(), clamp(limit, 1, 100));
  }

  @Transactional
  public int expireStaleSuspendedRooms() {
    long now = nowSec();
    long activeSessionCutoff = now - MEMBER_SESSION_STALE_SECONDS;
    List<RoomRecord> roomsWithStaleHosts = jdbc.query("""
        SELECT r.id, r.hash, r.host_user_id, r.status, r.max_members, r.host_only_control, r.allow_chat
        FROM rooms r
        WHERE r.status = 'open'
          AND r.host_last_seen_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM room_member_sessions s
            WHERE s.room_id = r.id
              AND s.user_id = r.host_user_id
              AND s.status = 'active'
              AND s.last_seen_at >= ?
          )
        ORDER BY r.host_last_seen_at ASC
        LIMIT 100
        FOR UPDATE
        """, roomRecordMapper(), activeSessionCutoff, activeSessionCutoff);
    for (RoomRecord room : roomsWithStaleHosts) {
      suspendHost(room, room.hostUserId(), now, "room.host.disconnected");
    }

    long graceSeconds = hostDisconnectGraceSeconds();
    List<RoomRecord> staleRooms = jdbc.query("""
        SELECT id, hash, host_user_id, status, max_members, host_only_control, allow_chat
        FROM rooms
        WHERE status = 'host_disconnected'
          AND COALESCE(expires_at, host_disconnected_at + ?) <= ?
        ORDER BY host_disconnected_at ASC
        LIMIT 100
        FOR UPDATE
        """, roomRecordMapper(), graceSeconds, now);

    for (RoomRecord room : staleRooms) {
      dismissRoomRecord(room, room.hostUserId(), "room.dismissed.host_timeout");
    }
    return roomsWithStaleHosts.size() + staleRooms.size();
  }

  private RoomSnapshot loadSnapshot(UUID roomId) {
    RoomView room = roomViewById(roomId);
    return new RoomSnapshot(
        room,
        membersForRoom(roomId),
        playbackForRoom(roomId),
        messagesForRoom(roomId, DEFAULT_MESSAGE_LIMIT),
        activityLogsForRoom(roomId, DEFAULT_LOG_LIMIT));
  }

  private RoomRecord requireRoom(String hash) {
    return requireRoom(hash, false);
  }

  private RoomRecord requireRoomForUpdate(String hash) {
    return requireRoom(hash, true);
  }

  private RoomRecord requireRoom(String hash, boolean forUpdate) {
    List<RoomRecord> rows = jdbc.query("""
        SELECT id, hash, host_user_id, status, max_members, host_only_control, allow_chat
        FROM rooms
        WHERE hash = ?
        LIMIT 1
        """ + (forUpdate ? " FOR UPDATE" : ""), roomRecordMapper(), normalizeHash(hash));
    if (rows.isEmpty()) throw new RoomHttpException(HttpStatus.NOT_FOUND, "room_not_found");
    return rows.get(0);
  }

  private RoomRecord requireOpenRoomForUpdate(String hash) {
    RoomRecord room = requireRoomForUpdate(hash);
    if (!STATUS_OPEN.equals(room.status())) throw new RoomHttpException(HttpStatus.CONFLICT, "room_closed");
    return room;
  }

  private RoomRecord requireLiveRoomForUpdate(String hash) {
    RoomRecord room = requireRoomForUpdate(hash);
    if (!STATUS_OPEN.equals(room.status()) && !STATUS_HOST_DISCONNECTED.equals(room.status())) {
      throw new RoomHttpException(HttpStatus.CONFLICT, "room_closed");
    }
    return room;
  }

  private RoomRecord findLiveHostRoomForUpdate(String userId) {
    List<RoomRecord> rows = jdbc.query("""
        SELECT id, hash, host_user_id, status, max_members, host_only_control, allow_chat
        FROM rooms
        WHERE host_user_id = ?
          AND status IN ('open', 'host_disconnected')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        """, roomRecordMapper(), userId);
    return rows.isEmpty() ? null : rows.get(0);
  }

  private void suspendStaleHostedRoom(String userId) {
    long now = nowSec();
    long activeSessionCutoff = now - MEMBER_SESSION_STALE_SECONDS;
    List<RoomRecord> rows = jdbc.query("""
        SELECT id, hash, host_user_id, status, max_members, host_only_control, allow_chat
        FROM rooms
        WHERE host_user_id = ?
          AND status = 'open'
          AND host_last_seen_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM room_member_sessions s
            WHERE s.room_id = rooms.id
              AND s.user_id = rooms.host_user_id
              AND s.status = 'active'
              AND s.last_seen_at >= ?
          )
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        """, roomRecordMapper(), userId, activeSessionCutoff, activeSessionCutoff);
    if (!rows.isEmpty()) {
      RoomRecord room = rows.get(0);
      suspendHost(room, room.hostUserId(), now, "room.host.disconnected");
    }
  }

  private void requireHost(RoomRecord room, InternalUser user) {
    if (!room.hostUserId().equals(user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "host_required");
    }
  }

  private void requireControl(RoomRecord room, InternalUser user) {
    if (room.hostOnlyControl() && !room.hostUserId().equals(user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "host_control_required");
    }
    if (!isActiveMember(room.id(), user.userId())) {
      throw new RoomHttpException(HttpStatus.FORBIDDEN, "not_room_member");
    }
  }

  private boolean isKnownMember(UUID roomId, String userId) {
    Integer count = jdbc.queryForObject(
        "SELECT COUNT(*) FROM room_members WHERE room_id = ? AND user_id = ?",
        Integer.class,
        roomId,
        userId);
    return count != null && count > 0;
  }

  private boolean isActiveMember(UUID roomId, String userId) {
    Integer count = jdbc.queryForObject(
        "SELECT COUNT(*) FROM room_members WHERE room_id = ? AND user_id = ? AND status = 'active'",
        Integer.class,
        roomId,
        userId);
    return count != null && count > 0;
  }

  private void touchMemberSession(UUID roomId, String userId, String clientId, long now) {
    String normalizedClientId = normalizeClientId(clientId, userId);
    jdbc.update("""
        INSERT INTO room_member_sessions
          (room_id, user_id, client_id, status, joined_at, last_seen_at, left_at)
        VALUES (?, ?, ?, 'active', ?, ?, NULL)
        ON CONFLICT (room_id, user_id, client_id)
        DO UPDATE SET status = 'active',
                      last_seen_at = EXCLUDED.last_seen_at,
                      left_at = NULL
        """, roomId, userId, normalizedClientId, now, now);
  }

  private void markMemberSessionLeft(UUID roomId, String userId, String clientId, long now) {
    String normalizedClientId = normalizeClientId(clientId, userId);
    jdbc.update("""
        UPDATE room_member_sessions
        SET status = 'left',
            left_at = ?,
            last_seen_at = ?
        WHERE room_id = ? AND user_id = ? AND client_id = ?
        """, now, now, roomId, userId, normalizedClientId);
  }

  private boolean hasActiveMemberSession(UUID roomId, String userId, long now) {
    Integer count = jdbc.queryForObject("""
        SELECT COUNT(*)
        FROM room_member_sessions
        WHERE room_id = ?
          AND user_id = ?
          AND status = 'active'
          AND last_seen_at >= ?
        """, Integer.class, roomId, userId, now - MEMBER_SESSION_STALE_SECONDS);
    return count != null && count > 0;
  }

  private static String normalizeClientId(String clientId, String userId) {
    String value = clientId == null ? "" : clientId.trim();
    if (value.isEmpty()) {
      String fallbackUserId = userId == null ? "" : userId.trim();
      return "legacy:" + fallbackUserId;
    }
    return value.length() <= 128 ? value : value.substring(0, 128);
  }

  private void insertMember(UUID roomId, InternalUser user, String role, long now) {
    jdbc.update("""
        INSERT INTO room_members
          (id, room_id, user_id, display_name_snapshot, avatar_url_snapshot, role, status, joined_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        """, UUID.randomUUID(), roomId, user.userId(), user.safeDisplayName(), trimToNull(user.avatarUrl()), role, now);
  }

  private void ensureActiveMember(UUID roomId, InternalUser user, String role, long now) {
    if (isKnownMember(roomId, user.userId())) {
      jdbc.update("""
          UPDATE room_members
          SET role = ?,
              status = 'active',
              removed_at = NULL,
              display_name_snapshot = ?,
              avatar_url_snapshot = ?
          WHERE room_id = ? AND user_id = ?
          """, role, user.safeDisplayName(), trimToNull(user.avatarUrl()), roomId, user.userId());
    } else {
      insertMember(roomId, user, role, now);
    }
  }

  private void dismissRoomRecord(RoomRecord room, String actorUserId, String logKind) {
    long now = nowSec();
    List<String> targets = targetsForRoom(room.id());
    jdbc.update("""
        UPDATE rooms
        SET status = 'closed',
            closed_at = ?,
            expires_at = NULL
        WHERE id = ? AND status IN ('open', 'host_disconnected')
        """, now, room.id());
    insertLog(room.id(), actorUserId, logKind, "{}", now);
    publish(room.hash(), "room.dismissed", targets, Map.of(
        "roomHash", room.hash(),
        "closedAt", now,
        "reason", logKind));
  }

  private void suspendHost(RoomRecord room, String actorUserId, long now, String logKind) {
    long expiresAt = now + hostDisconnectGraceSeconds();
    jdbc.update("""
        UPDATE rooms
        SET status = 'host_disconnected',
            host_disconnected_at = ?,
            expires_at = ?,
            host_last_seen_at = ?
        WHERE id = ? AND status = 'open'
        """, now, expiresAt, now, room.id());
    jdbc.update("""
        UPDATE room_playback_state
        SET current_time_sec = 0,
            paused = TRUE,
            playback_rate = 1,
            revision = revision + 1,
            updated_by = ?,
            updated_at = ?
        WHERE room_id = ?
        """, actorUserId, now, room.id());
    insertLog(room.id(), actorUserId, logKind, jsonPair("expiresAt", String.valueOf(expiresAt)), now);
    publish(room.hash(), "room.host.disconnected", targetsForRoom(room.id()), Map.of(
        "roomHash", room.hash(),
        "disconnectedAt", now,
        "expiresAt", expiresAt,
        "playback", playbackForRoom(room.id())));
  }

  private void insertLog(UUID roomId, String actorUserId, String kind, String payloadJson, long now) {
    jdbc.update("""
        INSERT INTO room_activity_logs (id, room_id, actor_user_id, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """, UUID.randomUUID(), roomId, actorUserId, kind, payloadJson == null ? "{}" : payloadJson, now);
  }

  private String createUniqueRoomHash() {
    for (int attempt = 0; attempt < 12; attempt += 1) {
      String hash = randomHash();
      Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM rooms WHERE hash = ?", Integer.class, hash);
      if (count == null || count == 0) return hash;
    }
    throw new RoomHttpException(HttpStatus.INTERNAL_SERVER_ERROR, "room_hash_exhausted");
  }

  private static String randomHash() {
    StringBuilder out = new StringBuilder(6);
    for (int i = 0; i < 6; i += 1) {
      out.append(HASH_ALPHABET[RANDOM.nextInt(HASH_ALPHABET.length)]);
    }
    return out.toString();
  }

  private RoomView roomViewById(UUID roomId) {
    return jdbc.queryForObject("""
        SELECT id, hash, title, notice, host_user_id, status, max_members,
               host_only_control, allow_chat, created_at, closed_at,
               host_last_seen_at, host_disconnected_at, expires_at
        FROM rooms
        WHERE id = ?
        """, (rs, rowNum) -> new RoomView(
        rs.getString("id"),
        rs.getString("hash"),
        rs.getString("title"),
        rs.getString("notice"),
        rs.getString("host_user_id"),
        rs.getString("status"),
        rs.getInt("max_members"),
        rs.getBoolean("host_only_control"),
        rs.getBoolean("allow_chat"),
        rs.getLong("created_at"),
        nullableLong(rs, "closed_at"),
        nullableLong(rs, "host_last_seen_at"),
        nullableLong(rs, "host_disconnected_at"),
        nullableLong(rs, "expires_at")), roomId);
  }

  private List<MemberView> membersForRoom(UUID roomId) {
    long cutoff = nowSec() - MEMBER_SESSION_STALE_SECONDS;
    return jdbc.query("""
        SELECT m.id, m.user_id, m.display_name_snapshot, m.avatar_url_snapshot,
               m.role, m.status, m.joined_at, m.removed_at
        FROM room_members m
        WHERE m.room_id = ?
          AND m.status = 'active'
          AND EXISTS (
            SELECT 1
            FROM room_member_sessions s
            WHERE s.room_id = m.room_id
              AND s.user_id = m.user_id
              AND s.status = 'active'
              AND s.last_seen_at >= ?
          )
        ORDER BY CASE WHEN m.role = 'host' THEN 0 ELSE 1 END, m.joined_at ASC
        """, memberMapper(), roomId, cutoff);
  }

  private MemberView memberForUser(UUID roomId, String userId) {
    return jdbc.queryForObject("""
        SELECT id, user_id, display_name_snapshot, avatar_url_snapshot, role, status, joined_at, removed_at
        FROM room_members
        WHERE room_id = ? AND user_id = ?
        """, memberMapper(), roomId, userId);
  }

  private PlaybackView playbackForRoom(UUID roomId) {
    return jdbc.queryForObject("""
        SELECT media_id, media_key, media_title_snapshot, media_duration_sec, source_type,
               current_time_sec, paused, playback_rate, revision, updated_by, updated_at
        FROM room_playback_state
        WHERE room_id = ?
        """, (rs, rowNum) -> new PlaybackView(
        rs.getString("media_id"),
        rs.getString("media_key"),
        rs.getString("media_title_snapshot"),
        nullableDouble(rs, "media_duration_sec"),
        rs.getString("source_type"),
        rs.getDouble("current_time_sec"),
        rs.getBoolean("paused"),
        rs.getDouble("playback_rate"),
        rs.getLong("revision"),
        rs.getString("updated_by"),
        rs.getLong("updated_at")), roomId);
  }

  private List<MessageView> messagesForRoom(UUID roomId, int limit) {
    List<MessageView> rows = jdbc.query("""
        SELECT id, media_id, media_key, video_time_sec, sender_user_id, sender_name_snapshot,
               sender_avatar_url_snapshot, body, kind, created_at
        FROM room_messages
        WHERE room_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """, messageMapper(), roomId, limit);
    List<MessageView> ordered = new ArrayList<>(rows);
    java.util.Collections.reverse(ordered);
    return ordered;
  }

  private MessageView messageById(UUID id) {
    return jdbc.queryForObject("""
        SELECT id, media_id, media_key, video_time_sec, sender_user_id, sender_name_snapshot,
               sender_avatar_url_snapshot, body, kind, created_at
        FROM room_messages
        WHERE id = ?
        """, messageMapper(), id);
  }

  private List<ActivityLogView> activityLogsForRoom(UUID roomId, int limit) {
    List<ActivityLogView> rows = jdbc.query("""
        SELECT l.id,
               l.actor_user_id,
               m.display_name_snapshot AS actor_name,
               l.kind,
               l.payload_json,
               l.created_at
        FROM room_activity_logs l
        LEFT JOIN room_members m
          ON m.room_id = l.room_id
         AND m.user_id = l.actor_user_id
        WHERE l.room_id = ?
        ORDER BY l.created_at DESC
        LIMIT ?
        """, (rs, rowNum) -> new ActivityLogView(
        rs.getString("id"),
        rs.getString("actor_user_id"),
        rs.getString("actor_name"),
        rs.getString("kind"),
        rs.getString("payload_json"),
        rs.getLong("created_at")), roomId, limit);
    List<ActivityLogView> ordered = new ArrayList<>(rows);
    java.util.Collections.reverse(ordered);
    return ordered;
  }

  private List<String> targetsForRoom(UUID roomId) {
    return jdbc.queryForList("""
        SELECT user_id
        FROM room_members
        WHERE room_id = ? AND status = 'active'
        """, String.class, roomId);
  }

  private void publish(String hash, String type, List<String> targets, Map<String, Object> payload) {
    realtimePublisher.publish(type, targets, payload == null ? Map.of("roomHash", hash) : payload);
  }

  private static RowMapper<RoomRecord> roomRecordMapper() {
    return (rs, rowNum) -> new RoomRecord(
        UUID.fromString(rs.getString("id")),
        rs.getString("hash"),
        rs.getString("host_user_id"),
        rs.getString("status"),
        rs.getInt("max_members"),
        rs.getBoolean("host_only_control"),
        rs.getBoolean("allow_chat"));
  }

  private static RowMapper<MemberView> memberMapper() {
    return (rs, rowNum) -> new MemberView(
        rs.getString("id"),
        rs.getString("user_id"),
        rs.getString("display_name_snapshot"),
        rs.getString("avatar_url_snapshot"),
        rs.getString("role"),
        rs.getString("status"),
        rs.getLong("joined_at"),
        nullableLong(rs, "removed_at"));
  }

  private static RowMapper<MessageView> messageMapper() {
    return (rs, rowNum) -> new MessageView(
        rs.getString("id"),
        rs.getString("media_id"),
        rs.getString("media_key"),
        nullableDouble(rs, "video_time_sec"),
        rs.getString("sender_user_id"),
        rs.getString("sender_name_snapshot"),
        rs.getString("sender_avatar_url_snapshot"),
        rs.getString("body"),
        rs.getString("kind"),
        rs.getLong("created_at"));
  }

  private static String normalizeHash(String value) {
    return normalize(value, "", 16).replaceAll("[^A-Za-z0-9_-]", "").toUpperCase();
  }

  private static String normalize(String value, String fallback, int maxLength) {
    String text = value == null ? "" : value.trim().replaceAll("\\s+", " ");
    if (text.isEmpty()) text = fallback;
    return text.length() > maxLength ? text.substring(0, maxLength) : text;
  }

  private static String normalizeNullable(String value, int maxLength) {
    String text = normalize(value, "", maxLength);
    return text.isEmpty() ? null : text;
  }

  private static String trimToNull(String value) {
    String text = value == null ? "" : value.trim();
    return text.isEmpty() ? null : text;
  }

  private static long nowSec() {
    return System.currentTimeMillis() / 1000L;
  }

  private static int clamp(int value, int min, int max) {
    return Math.min(Math.max(value, min), max);
  }

  private static double clampDouble(double value, double min, double max) {
    if (!Double.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  private static double safeNonNegative(Double value) {
    if (value == null || !Double.isFinite(value)) return 0;
    return Math.max(0, value);
  }

  private static Long nullableLong(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
    long value = rs.getLong(column);
    return rs.wasNull() ? null : value;
  }

  private static Double nullableDouble(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
    double value = rs.getDouble(column);
    return rs.wasNull() ? null : value;
  }

  private static String jsonPair(String key, String value) {
    return "{\"" + escapeJson(key) + "\":\"" + escapeJson(value) + "\"}";
  }

  private long hostDisconnectGraceSeconds() {
    AppProperties.RoomLifecycle lifecycle = appProperties.roomLifecycle();
    if (lifecycle == null || lifecycle.hostDisconnectGraceSeconds() <= 0) return 600;
    return lifecycle.hostDisconnectGraceSeconds();
  }

  private static String escapeJson(String value) {
    return value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  private record RoomRecord(
      UUID id,
      String hash,
      String hostUserId,
      String status,
      int maxMembers,
      boolean hostOnlyControl,
      boolean allowChat
  ) {
  }
}
