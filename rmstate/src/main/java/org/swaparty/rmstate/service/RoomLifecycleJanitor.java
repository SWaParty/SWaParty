package org.swaparty.rmstate.service;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class RoomLifecycleJanitor {
  private final RoomService roomService;

  public RoomLifecycleJanitor(RoomService roomService) {
    this.roomService = roomService;
  }

  @Scheduled(fixedDelayString = "${swaparty.room-lifecycle.cleanup-fixed-delay-ms:60000}")
  public void expireStaleSuspendedRooms() {
    roomService.expireStaleSuspendedRooms();
  }
}
