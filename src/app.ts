import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { allowedOrigins, env } from './config/env';
import authRoutes from './routes/auth.routes';
import aiTravelAdvisorRoutes from './routes/ai-travel-advisor.routes';
import brandingRoutes from './routes/branding.routes';
import auditLogsRoutes from './routes/audit-logs.routes';
import availableDatesRoutes from './routes/available-dates.routes';
import blogRoutes from './routes/blog.routes';
import blogCategoriesRoutes from './routes/blog-categories.routes';
import bookingsRoutes from './routes/bookings.routes';
import categoriesRoutes from './routes/categories.routes';
import contactRoutes from './routes/contact.routes';
import countriesRoutes from './routes/countries.routes';
import lodgesRoutes from './routes/lodges.routes';
import activitiesRoutes from './routes/activities.routes';
import dashboardRoutes from './routes/dashboard.routes';
import departuresRoutes from './routes/departures.routes';
import destinationsRoutes from './routes/destinations.routes';
import faqsRoutes from './routes/faqs.routes';
import galleryRoutes from './routes/gallery.routes';
import homepageRoutes from './routes/homepage.routes';
import hubspotRoutes from './routes/hubspot.routes';
import itinerariesRoutes from './routes/itineraries.routes';
import mediaRoutes from './routes/media.routes';
import paymentsRoutes from './routes/payments.routes';
import permissionsRoutes from './routes/permissions.routes';
import pricingOptionsRoutes from './routes/pricing-options.routes';
import publicRoutes from './routes/public.routes';
import rolesRoutes from './routes/roles.routes';
import settingsRoutes from './routes/settings.routes';
import testimonialsRoutes from './routes/testimonials.routes';
import tourInclusionsRoutes from './routes/tour-inclusions.routes';
import tourExclusionsRoutes from './routes/tour-exclusions.routes';
import tourImagesRoutes from './routes/tour-images.routes';
import toursRoutes from './routes/tours.routes';
import uploadRoutes from './routes/upload.routes';
import usersRoutes from './routes/users.routes';
import { errorMiddleware } from './middleware/error.middleware';
import { notFoundMiddleware } from './middleware/not-found.middleware';
import { sendSuccess } from './utils/api-response';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS.'));
    },
    credentials: true
  })
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  return sendSuccess(res, 'API is healthy.', {
    uptime: process.uptime(),
    environment: env.NODE_ENV
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/ai', aiTravelAdvisorRoutes);
app.use('/api/tours', toursRoutes);
app.use('/api/tour-inclusions', tourInclusionsRoutes);
app.use('/api/tour-exclusions', tourExclusionsRoutes);
app.use('/api/tour-images', tourImagesRoutes);
app.use('/api/itineraries', itinerariesRoutes);
app.use('/api/available-dates', availableDatesRoutes);
app.use('/api/pricing-options', pricingOptionsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/destinations', destinationsRoutes);
app.use('/api/countries', countriesRoutes);
app.use('/api/lodges', lodgesRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/blog-categories', blogCategoriesRoutes);
app.use('/api/gallery', galleryRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/testimonials', testimonialsRoutes);
app.use('/api/faqs', faqsRoutes);
app.use('/api/homepage', homepageRoutes);
app.use('/api/hubspot', hubspotRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/departures', departuresRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
