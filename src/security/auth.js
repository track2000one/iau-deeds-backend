import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const PASSWORD_ROUNDS = 12;
const TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET is missing or too short. Use at least 32 random characters.'
    );
  }

  return secret;
};

export const hashPassword = async (password) => {
  return bcrypt.hash(password, PASSWORD_ROUNDS);
};

export const verifyPassword = async (password, passwordHash) => {
  return bcrypt.compare(password, passwordHash);
};

export const signAccessToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
    },
    getJwtSecret(),
    {
      expiresIn: TOKEN_EXPIRES_IN,
      issuer: 'iau-deeds-backend',
      audience: 'iau-deeds-frontend',
    }
  );
};

export const verifyAccessToken = (token) => {
  return jwt.verify(token, getJwtSecret(), {
    issuer: 'iau-deeds-backend',
    audience: 'iau-deeds-frontend',
  });
};

export const serializeUser = (user) => ({
  uid: user.id,
  email: user.email,
  username: user.username,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  lastLoginAt: user.lastLoginAt,
});
