import Joi from "joi";

export const signUpDto = Joi.object({
  name: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
});

export const signInDto = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
});

export const magicLinkDto = Joi.object({
  email: Joi.string().email().required(),
});
