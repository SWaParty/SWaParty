package org.swaparty.rmstate.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.swaparty.rmstate.model.ApiResponse;

@RestControllerAdvice
public class ApiExceptionHandler {
  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(RoomHttpException.class)
  ResponseEntity<ApiResponse<Object>> handleRoomHttpException(RoomHttpException ex) {
    return ResponseEntity.status(ex.status()).body(ApiResponse.error(ex.getMessage()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  ResponseEntity<ApiResponse<Object>> handleValidation() {
    return ResponseEntity.badRequest().body(ApiResponse.error("invalid_request"));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<ApiResponse<Object>> handleUnexpected(Exception ex) {
    log.error("Unhandled room API exception", ex);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(ApiResponse.error("internal_error"));
  }
}
