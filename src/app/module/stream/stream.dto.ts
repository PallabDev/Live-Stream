import Joi from "joi";

export const createStreamDto = Joi.object({
  title: Joi.string().min(3).max(100).trim().required().messages({
    "string.empty": "Stream title is required.",
    "string.min": "Stream title must be at least 3 characters long.",
    "string.max": "Stream title cannot exceed 100 characters.",
  }),
});
