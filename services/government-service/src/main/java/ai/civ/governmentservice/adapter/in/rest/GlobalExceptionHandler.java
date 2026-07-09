package ai.civ.governmentservice.adapter.in.rest;

import ai.civ.governmentservice.application.error.GovernanceRejectedException;
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
 * RFC 7807 problem+json everywhere, always carrying the correlationId (the
 * event-service pattern). Governance rejections additionally carry a
 * machine-readable errorCode — the same vocabulary M2-7's GovernanceRejected
 * events will use, so a dashboard or an agent percept can switch on it.
 */
@RestControllerAdvice
class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(GovernanceRejectedException.class)
    ProblemDetail governanceRejected(GovernanceRejectedException e) {
        HttpStatus status = switch (e.errorCode()) {
            case UNKNOWN_ELECTION -> HttpStatus.NOT_FOUND;
            case WINDOW_CLOSED, ALREADY_VOTED, ALREADY_A_CANDIDATE, STALE_COMMAND -> HttpStatus.CONFLICT;
            case NOT_A_CANDIDATE -> HttpStatus.UNPROCESSABLE_ENTITY;
            case INVALID_PARAMS -> HttpStatus.BAD_REQUEST;
        };
        ProblemDetail problem = problem(status, e.getMessage());
        problem.setProperty("errorCode", e.errorCode().name());
        return problem;
    }

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
