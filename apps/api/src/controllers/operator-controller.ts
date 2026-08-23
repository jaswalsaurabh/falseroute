import { type Request, type Response } from 'express';

export class OperatorController {
  session = (req: Request, res: Response): void => {
    res.status(200).json({
      authenticated: true,
      correlationId: req.correlationId,
    });
  };
}
