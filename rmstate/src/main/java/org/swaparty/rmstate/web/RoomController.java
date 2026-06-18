package org.swaparty.rmstate.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.swaparty.rmstate.config.InternalAuthFilter;
import org.swaparty.rmstate.model.ApiResponse;
import org.swaparty.rmstate.model.InternalUser;
import org.swaparty.rmstate.model.RoomDtos.ActivityLogView;
import org.swaparty.rmstate.model.RoomDtos.CreateRoomRequest;
import org.swaparty.rmstate.model.RoomDtos.JoinRoomRequest;
import org.swaparty.rmstate.model.RoomDtos.MessageRequest;
import org.swaparty.rmstate.model.RoomDtos.MessageView;
import org.swaparty.rmstate.model.RoomDtos.MountMediaRequest;
import org.swaparty.rmstate.model.RoomDtos.PlaybackRequest;
import org.swaparty.rmstate.model.RoomDtos.PlaybackView;
import org.swaparty.rmstate.model.RoomDtos.RoomSnapshot;
import org.swaparty.rmstate.service.RoomService;

@RestController
@RequestMapping("/internal/rooms")
public class RoomController {
  private final RoomService roomService;

  public RoomController(RoomService roomService) {
    this.roomService = roomService;
  }

  @PostMapping
  ApiResponse<RoomSnapshot> createRoom(@Valid @RequestBody CreateRoomRequest body, HttpServletRequest request) {
    return ApiResponse.ok(roomService.createRoom(body, currentUser(request), currentClientId(request)));
  }

  @GetMapping("/{roomHash}")
  ApiResponse<RoomSnapshot> getRoom(@PathVariable String roomHash, HttpServletRequest request) {
    return ApiResponse.ok(roomService.getSnapshot(roomHash, currentUser(request)));
  }

  @GetMapping("/active")
  ApiResponse<List<RoomSnapshot>> activeRooms(HttpServletRequest request) {
    return ApiResponse.ok(roomService.activeRooms(currentUser(request)));
  }

  @PostMapping("/{roomHash}/join")
  ApiResponse<RoomSnapshot> joinRoom(
      @PathVariable String roomHash,
      @RequestBody(required = false) JoinRoomRequest body,
      HttpServletRequest request) {
    return ApiResponse.ok(roomService.joinRoom(roomHash, body, currentUser(request), currentClientId(request)));
  }

  @PostMapping("/{roomHash}/close")
  ApiResponse<RoomSnapshot> closeRoom(@PathVariable String roomHash, HttpServletRequest request) {
    return ApiResponse.ok(roomService.closeRoom(roomHash, currentUser(request)));
  }

  @PostMapping("/{roomHash}/dismiss")
  ApiResponse<RoomSnapshot> dismissRoom(@PathVariable String roomHash, HttpServletRequest request) {
    return ApiResponse.ok(roomService.dismissRoom(roomHash, currentUser(request)));
  }

  @PostMapping("/{roomHash}/leave")
  ApiResponse<RoomSnapshot> leaveRoom(@PathVariable String roomHash, HttpServletRequest request) {
    return ApiResponse.ok(roomService.leaveRoom(roomHash, currentUser(request), currentClientId(request)));
  }

  @PostMapping("/{roomHash}/heartbeat")
  ApiResponse<RoomSnapshot> heartbeatRoom(@PathVariable String roomHash, HttpServletRequest request) {
    return ApiResponse.ok(roomService.heartbeatRoom(roomHash, currentUser(request), currentClientId(request)));
  }

  @PostMapping("/{roomHash}/media")
  ApiResponse<PlaybackView> mountMedia(
      @PathVariable String roomHash,
      @Valid @RequestBody MountMediaRequest body,
      HttpServletRequest request) {
    return ApiResponse.ok(roomService.mountMedia(roomHash, body, currentUser(request)));
  }

  @PostMapping("/{roomHash}/playback")
  ApiResponse<PlaybackView> updatePlayback(
      @PathVariable String roomHash,
      @Valid @RequestBody PlaybackRequest body,
      HttpServletRequest request) {
    return ApiResponse.ok(roomService.updatePlayback(roomHash, body, currentUser(request)));
  }

  @PostMapping("/{roomHash}/messages")
  ApiResponse<MessageView> createMessage(
      @PathVariable String roomHash,
      @Valid @RequestBody MessageRequest body,
      HttpServletRequest request) {
    return ApiResponse.ok(roomService.createMessage(roomHash, body, currentUser(request)));
  }

  @GetMapping("/{roomHash}/activity-logs")
  ApiResponse<List<ActivityLogView>> activityLogs(
      @PathVariable String roomHash,
      @RequestParam(defaultValue = "30") int limit,
      HttpServletRequest request) {
    return ApiResponse.ok(roomService.activityLogs(roomHash, currentUser(request), limit));
  }

  private static InternalUser currentUser(HttpServletRequest request) {
    Object value = request.getAttribute(InternalAuthFilter.USER_ATTRIBUTE);
    if (value instanceof InternalUser user) return user;
    throw new RoomHttpException(org.springframework.http.HttpStatus.UNAUTHORIZED, "unauthorized");
  }

  private static String currentClientId(HttpServletRequest request) {
    return request.getHeader("X-SWaParty-Client-Id");
  }
}
