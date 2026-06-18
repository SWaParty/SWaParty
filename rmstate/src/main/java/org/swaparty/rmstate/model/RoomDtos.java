package org.swaparty.rmstate.model;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

public final class RoomDtos {
  private RoomDtos() {
  }

  public record CreateRoomRequest(
      @Size(max = 160) String title,
      @Size(max = 4000) String notice,
      @Min(2) @Max(99) Integer maxMembers,
      Boolean hostOnlyControl,
      Boolean allowChat
  ) {
  }

  public record JoinRoomRequest(
      Boolean dismissHostedRoom
  ) {
  }

  public record MountMediaRequest(
      @NotBlank String mediaId,
      @Size(max = 2048) String mediaKey,
      @Size(max = 240) String mediaTitle,
      Double durationSec,
      @Size(max = 32) String sourceType
  ) {
  }

  public record PlaybackRequest(
      @NotBlank String action,
      Double currentTimeSec,
      Double playbackRate
  ) {
  }

  public record MessageRequest(
      @NotBlank @Size(max = 2000) String body,
      String mediaId,
      @Size(max = 2048) String mediaKey,
      Double videoTimeSec,
      @Size(max = 24) String kind
  ) {
  }

  public record RoomView(
      String id,
      String hash,
      String title,
      String notice,
      String hostUserId,
      String status,
      int maxMembers,
      boolean hostOnlyControl,
      boolean allowChat,
      long createdAt,
      Long closedAt,
      Long hostLastSeenAt,
      Long hostDisconnectedAt,
      Long expiresAt
  ) {
  }

  public record MemberView(
      String id,
      String userId,
      String displayName,
      String avatarUrl,
      String role,
      String status,
      long joinedAt,
      Long removedAt
  ) {
  }

  public record PlaybackView(
      String mediaId,
      String mediaKey,
      String mediaTitle,
      Double durationSec,
      String sourceType,
      double currentTimeSec,
      boolean paused,
      double playbackRate,
      long revision,
      String updatedBy,
      long updatedAt
  ) {
  }

  public record MessageView(
      String id,
      String mediaId,
      String mediaKey,
      Double videoTimeSec,
      String senderUserId,
      String senderName,
      String senderAvatarUrl,
      String body,
      String kind,
      long createdAt
  ) {
  }

  public record ActivityLogView(
      String id,
      String actorUserId,
      String actorName,
      String kind,
      String payloadJson,
      long createdAt
  ) {
  }

  public record RoomSnapshot(
      RoomView room,
      List<MemberView> members,
      PlaybackView playback,
      List<MessageView> messages,
      List<ActivityLogView> activityLogs
  ) {
  }
}
