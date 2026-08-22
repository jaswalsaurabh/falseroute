import { type Request, type Response, type NextFunction } from 'express';
import {
  CreateIntrusionEventRequestSchema,
  ListIntrusionEventsQuerySchema,
  UuidSchema,
} from '@false-route/contracts';
import { type EventService } from '../services/event-service.js';

export class EventController {
  constructor(private readonly eventService: EventService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedInput = CreateIntrusionEventRequestSchema.parse(req.body);
      const response = await this.eventService.createEvent(validatedInput);
      res.status(202).json(response);
    } catch (err) {
      next(err);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validatedQuery = ListIntrusionEventsQuerySchema.parse(req.query);
      const response = await this.eventService.listEvents(validatedQuery);
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = UuidSchema.parse(req.params.id);
      const response = await this.eventService.getEvent(id);
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };

  getDecision = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = UuidSchema.parse(req.params.id);
      const response = await this.eventService.getDecision(id);
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  };
}
