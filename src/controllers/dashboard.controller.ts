import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

type QueryFilter = {
  column: string;
  operator?: 'eq' | 'is' | 'not';
  value: string | number | boolean | null;
};

type Row = Record<string, unknown>;

const applyFilters = (query: any, filters: QueryFilter[] = []) => {
  let nextQuery = query;

  for (const filter of filters) {
    if (filter.operator === 'not') nextQuery = nextQuery.not(filter.column, 'is', filter.value);
    else if (filter.operator === 'is' || filter.value === null) nextQuery = nextQuery.is(filter.column, filter.value);
    else nextQuery = nextQuery.eq(filter.column, filter.value);
  }

  return nextQuery;
};

const safeCount = async (table: string, filters: QueryFilter[] = []) => {
  try {
    const query = applyFilters(supabase.from(table).select('id', { count: 'exact', head: true }), filters);
    const { count, error } = await query;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
};

const safeRows = async <T extends Row = Row>(
  table: string,
  select = '*',
  options: {
    ascending?: boolean;
    filters?: QueryFilter[];
    limit?: number;
    orderBy?: string;
  } = {}
) => {
  try {
    let query = applyFilters(supabase.from(table).select(select), options.filters ?? []);
    query = query.order(options.orderBy ?? 'created_at', { ascending: options.ascending ?? false }).limit(options.limit ?? 5);

    const { data, error } = await query;
    if (error) return [] as T[];
    return (data ?? []) as T[];
  } catch {
    return [] as T[];
  }
};

const paidRevenue = async () => {
  const rows = await safeRows<{ amount?: number | string }>('booking_payments', 'amount,status', {
    filters: [{ column: 'status', value: 'paid' }],
    limit: 10000
  });

  return rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
};

const missingChildCounts = async () => {
  const [tours, itineraryDays, availableDates] = await Promise.all([
    safeRows<{ id: string }>('tours', 'id', {
      filters: [{ column: 'deleted_at', value: null }],
      limit: 10000
    }),
    safeRows<{ tour_id: string }>('itinerary_days', 'tour_id', { limit: 10000 }),
    safeRows<{ tour_id: string }>('available_dates', 'tour_id', { limit: 10000 })
  ]);

  const itineraryTourIds = new Set(itineraryDays.map((row) => row.tour_id).filter(Boolean));
  const availableDateTourIds = new Set(availableDates.map((row) => row.tour_id).filter(Boolean));

  return {
    toursWithoutItinerary: tours.filter((tour) => !itineraryTourIds.has(tour.id)).length,
    toursWithoutAvailableDates: tours.filter((tour) => !availableDateTourIds.has(tour.id)).length
  };
};

export const getDashboardStats = asyncHandler(async (_req, res) => {
  const [
    totalTours,
    publishedTours,
    draftTours,
    destinations,
    totalBookings,
    pendingBookings,
    confirmedBookings,
    totalRevenue,
    unreadMessages,
    mediaFiles,
    blogPosts,
    aiConversations,
    cancelledBookings,
    completedBookings,
    rejectedBookings,
    toursWithSeo,
    toursMissingImages,
    missingChildData,
    publishedDestinations,
    publishedBlogPosts,
    publishedFaqs,
    publishedTestimonials
  ] = await Promise.all([
    safeCount('tours', [{ column: 'deleted_at', value: null }]),
    safeCount('tours', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'published' }
    ]),
    safeCount('tours', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'draft' }
    ]),
    safeCount('destinations', [{ column: 'deleted_at', value: null }]),
    safeCount('booking_requests', [{ column: 'deleted_at', value: null }]),
    safeCount('booking_requests', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'pending' }
    ]),
    safeCount('booking_requests', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'confirmed' }
    ]),
    paidRevenue(),
    safeCount('contact_messages', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'new' }
    ]),
    safeCount('media_library', [{ column: 'deleted_at', value: null }]),
    safeCount('blog_posts', [{ column: 'deleted_at', value: null }]),
    safeCount('ai_conversations', [{ column: 'deleted_at', value: null }]),
    safeCount('booking_requests', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'cancelled' }
    ]),
    safeCount('booking_requests', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'completed' }
    ]),
    safeCount('booking_requests', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'rejected' }
    ]),
    safeCount('tours', [
      { column: 'deleted_at', value: null },
      { column: 'seo_title', operator: 'not', value: null },
      { column: 'meta_description', operator: 'not', value: null }
    ]),
    safeCount('tours', [
      { column: 'deleted_at', value: null },
      { column: 'main_image_url', value: null }
    ]),
    missingChildCounts(),
    safeCount('destinations', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'published' }
    ]),
    safeCount('blog_posts', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'published' }
    ]),
    safeCount('faqs', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'published' }
    ]),
    safeCount('testimonials', [
      { column: 'deleted_at', value: null },
      { column: 'status', value: 'published' }
    ])
  ]);

  const [recentBookings, recentMessages, recentTours, recentMedia, recentAuditLogs, featuredTours, featuredDestinations, latestBlogPosts] =
    await Promise.all([
      safeRows('booking_requests', 'id,booking_code,full_name,email,status,created_at,tours(title)', {
        filters: [{ column: 'deleted_at', value: null }],
        limit: 5
      }),
      safeRows('contact_messages', 'id,full_name,email,subject,status,created_at', {
        filters: [{ column: 'deleted_at', value: null }],
        limit: 5
      }),
      safeRows('tours', 'id,title,slug,status,created_at,updated_at', {
        filters: [{ column: 'deleted_at', value: null }],
        limit: 5
      }),
      safeRows('media_library', 'id,file_name,file_url,file_type,created_at', {
        filters: [{ column: 'deleted_at', value: null }],
        limit: 5
      }),
      safeRows('audit_logs', 'id,action,entity_type,entity_id,created_at', { limit: 5 }),
      safeRows('tours', 'id,title,slug,price_from,currency,status,main_image_url,is_featured,created_at', {
        filters: [
          { column: 'deleted_at', value: null },
          { column: 'is_featured', value: true }
        ],
        limit: 5
      }),
      safeRows('destinations', 'id,name,slug,country,status,main_image_url,image_url,is_featured,created_at', {
        filters: [
          { column: 'deleted_at', value: null },
          { column: 'is_featured', value: true }
        ],
        limit: 5
      }),
      safeRows('blog_posts', 'id,title,slug,status,featured_image_url,created_at,published_at', {
        filters: [{ column: 'deleted_at', value: null }],
        limit: 5
      })
    ]);

  const counts = {
    totalTours,
    publishedTours,
    draftTours,
    destinations,
    totalBookings,
    pendingBookings,
    confirmedBookings,
    totalRevenue,
    unreadMessages,
    mediaFiles,
    blogPosts,
    aiConversations
  };

  const bookingPipeline = {
    pending: pendingBookings,
    confirmed: confirmedBookings,
    cancelled: cancelledBookings,
    completed: completedBookings,
    rejected: rejectedBookings
  };

  const contentHealth = {
    toursWithSeo,
    toursMissingImages,
    toursWithoutItinerary: missingChildData.toursWithoutItinerary,
    toursWithoutAvailableDates: missingChildData.toursWithoutAvailableDates,
    publishedDestinations,
    publishedBlogPosts,
    publishedFaqs,
    publishedTestimonials
  };

  return sendSuccess(res, 'Dashboard stats fetched successfully.', {
    counts,
    bookingPipeline,
    contentHealth,
    recent: {
      bookings: recentBookings,
      messages: recentMessages,
      tours: recentTours,
      media: recentMedia,
      auditLogs: recentAuditLogs
    },
    featured: {
      tours: featuredTours,
      destinations: featuredDestinations,
      blogPosts: latestBlogPosts
    },
    // Backward-compatible legacy keys for any older dashboard consumers.
    tours: totalTours,
    publishedTours,
    draftTours,
    destinations,
    bookings: totalBookings,
    pendingBookings,
    confirmedBookings,
    totalRevenue,
    posts: blogPosts,
    messages: unreadMessages,
    newMessages: unreadMessages
  });
});
