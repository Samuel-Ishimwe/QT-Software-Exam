import { HttpException, HttpStatus } from '@nestjs/common';
import { Violation } from './violation';

export class SubdivisionRejectedException extends HttpException {
  constructor(violations: Violation[]) {
    super(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'subdivision_rejected',
        message: `subdivision rejected: ${violations.length} rule violation(s)`,
        violations,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
