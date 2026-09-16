import { HttpException, HttpStatus } from '@nestjs/common';
import { Violation } from './violation';

/**
 * 409, not 422: every violation this endpoint can report is a conflict against
 * live state read fresh at commit time (stale version, a neighbour that moved
 * under it, a cyclic-wait with another edit) -- unlike subdivision's 422s,
 * which are business-rule rejections of a self-consistent request.
 */
export class BoundaryEditConflictException extends HttpException {
  constructor(violations: Violation[]) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'boundary_edit_conflict',
        message: `boundary edit rejected: ${violations.length} conflict(s)`,
        violations,
      },
      HttpStatus.CONFLICT,
    );
  }
}
