package org.swaparty.rmstate.web;

import org.springframework.http.HttpStatus;

public class RoomHttpException extends RuntimeException {
  private final HttpStatus status;

  public RoomHttpException(HttpStatus status, String message) {
    super(message);
    this.status = status;
  }

  public HttpStatus status() {
    return status;
  }
}
