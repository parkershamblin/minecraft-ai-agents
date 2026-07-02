package ai.civ.eventservice.adapter.in.rest;

import java.net.URI;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * RFC 7807 problem+json everywhere, always carrying the correlationId so a
 * client error report can be grepped straight to the server logs. Extending
 * {@link ResponseEntityExceptionHandler} routes the framework's own errors
 * (404 via ResponseStatusException, 400 binding failures, ...) through
 * {@link #handleExceptionInternal}, where the correlationId is stamped onto
 * every ProblemDetail body — ours and Spring's alike.
 */
@RestControllerAdvice
class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badRequest(IllegalArgumentException e) {
        return problem(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    ProblemDetail unparseableParam(MethodArgumentTypeMismatchException e) {
        return problem(HttpStatus.BAD_REQUEST,
                "parameter '" + e.getName() + "' could not be parsed: " + e.getMessage());
    }

    @Override
    protected ResponseEntity<Object> handleExceptionInternal(
            Exception ex, Object body, HttpHeaders headers, HttpStatusCode statusCode, WebRequest request) {
        if (body instanceof ProblemDetail problemDetail) {
            stamp(problemDetail);
        } else if (ex instanceof org.springframework.web.ErrorResponse errorResponse) {
            stamp(errorResponse.getBody());
            body = errorResponse.getBody();
        }
        return super.handleExceptionInternal(ex, body, headers, statusCode, request);
    }

    private ProblemDetail problem(HttpStatus status, String detail) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setType(URI.create("https://ai-civilization-engine.local/problems/" + status.value()));
        stamp(problem);
        return problem;
    }

    private void stamp(ProblemDetail problem) {
        problem.setProperty("correlationId", MDC.get("correlationId"));
    }
}
