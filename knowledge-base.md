# User Journey Tracking System: Comprehensive Reference

## User States Overview

Our platform tracks users through several distinct states in their lifecycle:

1. **Free User**: Initial state for all users upon sign-up. These users have access to limited functionality.
2. **Trial User**: Users who have activated a 14-day trial with extended functionality.
3. **Bill Thru User**: Users on monthly subscription after trial or direct purchase.
4. **Annual User**: Users on yearly subscription plan.
5. **Churned User**: Previously paying users who have canceled their subscription.
6. **Reactivated User**: Users who reinstate their subscription after cancellation.

## Column Definitions

### Basic User Information

| Column | Type | Description |
|--------|------|-------------|
| `email` | STRING | User's email address - primary identifier |
| `uid` | STRING | Unique user identifier that matches across systems |
| `site` | STRING | Language/region code (en, pt, mx, de, etc.) |
| `increased_prices` | STRING | Whether user is in increased pricing test group ('true'/'false') |
| `sign_up` | TIMESTAMP | Date and time when user first registered |
| `traffic_source` | STRING | Marketing channel or source that brought the user (Google, Bing, Direct, etc.) |
| `traffic_device` | STRING | Device type used during sign-up (mobile, desktop, tablet) |
| `cohort_date` | TIMESTAMP | Trial start date used for cohort analysis (same as stripe_trial_date or paypal_trial_date) |

### Trial Tracking

| Column | Type | Description |
|--------|------|-------------|
| `stripe_trial` | INT64 | Flag (0/1) indicating if user had a trial through Stripe |
| `stripe_trial_date` | TIMESTAMP | Date when Stripe trial started |
| `paypal_trial` | INT64 | Flag (0/1) indicating if user had a trial through PayPal |
| `paypal_trial_date` | TIMESTAMP | Date when PayPal trial started |
| `trial` | INT64 | Consolidated flag (0/1) indicating if user had any trial |
| `free` | INT64 | Flag (0/1) indicating if user is/was on free plan (typically 1 for all users) |
| `channel` | STRING | Payment provider ('stripe' or 'paypal') for trial or subscription |

### Paid Subscription Tracking

| Column | Type | Description |
|--------|------|-------------|
| `bill_thru` | INT64 | Flag (0/1) indicating if user converted to monthly plan |
| `bill_thru_date` | TIMESTAMP | Date when monthly subscription started |
| `annual` | INT64 | Flag (0/1) indicating if user converted to annual plan |
| `channel_annual` | STRING | Payment provider for annual subscription ('stripe' or 'paypal') |
| `annual_date` | TIMESTAMP | Date when annual subscription started |

### Churn Tracking

| Column | Type | Description |
|--------|------|-------------|
| `cancel_date` | TIMESTAMP | Date when subscription was canceled (if applicable) |
| `churn` | INT64 | Subscription duration at cancellation (number of months) |
| `M1` through `M12` | INT64 | Flag (0/1) indicating if user churned after specific month (e.g., M1=1 means churned after 1 month) |

### Reactivation Tracking

| Column | Type | Description |
|--------|------|-------------|
| `reactivated` | INT64 | Flag (0/1) indicating if user has ever reactivated |
| `reactivation_date` | TIMESTAMP | Date of most recent reactivation |
| `reactivation_count` | INT64 | Number of times user has reactivated |
| `reactivation_type` | STRING | Type of reactivation ('trial' or 'paid') |
| `trial_reactivation` | INT64 | Flag (0/1) indicating trial-specific reactivation |
| `monthly_reactivation` | INT64 | Flag (0/1) indicating monthly plan reactivation |
| `annual_reactivation` | INT64 | Flag (0/1) indicating annual plan reactivation |
| `reactivation_source` | STRING | UI element that triggered reactivation |
| `trial_reactivation_successful` | INT64 | Flag (0/1) indicating successful trial reactivation (converted to paid) |
| `paid_reactivation_successful` | INT64 | Flag (0/1) indicating successful paid reactivation (subsequent payment) |
| `reactivation_successful` | INT64 | Combined flag (0/1) for overall reactivation success |
| `reactivation_timing` | STRING | Classification of when reactivation occurred: 'during_subscription_period', 'after_inactive_period', or 'other_pattern' (see details below) |

### Dispute Tracking

| Column | Type | Description |
|--------|------|-------------|
| `disputed` | INT64 | Flag (0/1) indicating if user had a payment dispute |
| `dispute_count` | INT64 | Number of payment disputes |

## Detailed State Definitions

### Free User State
- **Identification**: `free = 1` and `trial = 0` and `bill_thru = 0` and `annual = 0`
- **Period**: From sign-up until trial activation or subscription purchase
- **Features**: Limited functionality with specific caps:
  - Maximum of 2 QR codes can be created
  - Maximum of 10 scans per QR code
- **Metrics**: Free QR codes created, time to conversion

### Trial Period
- **Identification**: `trial = 1`
- **Duration**: 14 days from trial activation
- **Features**: Full platform functionality for limited time with no restrictions
- **Trigger**: Initial payment of $1.95 (Stripe) or equivalent
- **End States**: Conversion to paid (bill_thru=1) or lapse to free (trial=1, bill_thru=0)
- **Cohort Definition**: The trial start date (`stripe_trial_date` or `paypal_trial_date`) is used as the cohort date for tracking user groups and analyzing conversion metrics

### Bill Thru Cycle (Monthly Subscription)
- **Identification**: `bill_thru = 1`
- **Billing**: Recurring monthly charges ($28.95 standard pricing)
- **Features**: Full platform functionality
- **Renewal**: Automatic monthly renewal until cancellation
- **Churn Definition**: `bill_thru = 1` and `cancel_date IS NOT NULL`

### Annual Subscription
- **Identification**: `annual = 1`
- **Billing**: One-time yearly payment ($179.40 standard pricing)
- **Features**: Full platform functionality with discount compared to monthly
- **Renewal**: Annual until cancellation
- **Churn Definition**: `annual = 1` and `cancel_date IS NOT NULL`

## Reactivation UI Sources

| Source Value | Description | Typical User Flow |
|--------------|-------------|-------------------|
| `dashboard_navigation_settings` | Settings page navigation | User navigates to settings to reactivate |
| `14_day_trial_canceled_reactivate` | Trial cancellation banner | User clicks reactivate after canceling trial |
| `subscription_will_end_banner_continue_subscription` | End of subscription notice | User continues from expiration warning |
| `subscription_days_remaining_banner_continue_subscription` | Days remaining banner | User continues from countdown notice |
| `qr_code_element_reactivate` | QR code interface element | User reactivates while using QR codes |
| `upgrade_banner_all_free_scans_used_upgrade` | Free scan limit reached | User upgrades after hitting scan limit |
| `dashboard_upgrade_banner_get_unlimited` | Dashboard upgrade prompt | User upgrades from main dashboard |
| `analytics_page_see_scans_activity` | Analytics engagement | User resubscribes from analytics page |
| `expired_account_login_redirect_to_upgrade_plan` | Expired account flow | User reactivates after login to expired account |
| `other` | Untracked sources | Reactivations from other UI elements |

## Success Metrics Definitions

### Trial Reactivation Success
- **Definition**: User reactivates a canceled trial and subsequently converts to paid subscription
- **Measurement**: `bill_thru_date > reactivation_date` for trial reactivations
- **Time Window**: Typically within 14 days of reactivation (trial period)

### Paid Reactivation Success
- **Definition**: User reactivates a canceled paid subscription and continues with subsequent billing cycles
- **Measurement**: Existence of billing cycle/payment event after reactivation date
- **Monthly Success**: Next monthly payment occurred after reactivation
- **Annual Success**: Continued active annual subscription after reactivation

### Reactivation Timing Classification
- **Definition**: Categorizes when in the subscription lifecycle a reactivation occurs
- **Values**:
  - `during_subscription_period`: Reactivation occurred after cancellation but before the subscription benefits ended. For monthly plans, this is within 30 days after the most recent bill_thru_date. For annual plans, this is within 365 days of the annual_date.
  - `after_inactive_period`: Reactivation occurred after subscription benefits ended and user was reverted to free status.
  - `other_pattern`: Reactivations that don't fall into the above categories (e.g., reactivation without a prior cancellation).
- **Usage**: This classification helps identify whether users are reactivating while still having access to premium features or after losing premium access, which provides insights into reactivation motivations.

## Key Conversion Points

1. **Free to Trial**: Activating 14-day trial (first payment)
2. **Trial to Paid**: Converting from trial to monthly/annual plan
3. **Monthly to Annual**: Upgrading from monthly to discounted annual plan
4. **Churn to Reactivated**: Resubscribing after cancellation
5. **Reactivation to Sustained**: Maintaining subscription after reactivation

## Acquisition Channel Analysis

The tracking system includes traffic source and device information, allowing for detailed acquisition analysis:

### Traffic Source Values
- **Google**: Primary search engine traffic source
- **Bing**: Secondary search engine traffic source
- **Facebook**: Social media traffic source (rare)
- **NULL/Blank**: Unknown or untracked traffic source

### Device Type Values
- **desktop**: Users who accessed via desktop computers
- **mobile**: Users who accessed via smartphones or tablets

These fields enable segmentation of the entire user journey by acquisition channel and device type, providing insights into which sources produce the highest quality users and best conversion rates.

## Technical Implementation Notes

### Reactivation Timing Logic
The `reactivation_timing` field uses timestamp comparisons to determine when a reactivation occurred relative to the user's subscription period:

- For monthly subscribers: We check if reactivation happened within 30 days after their bill_thru_date
- For annual subscribers: We check if reactivation happened within 365 days after their annual_date
- All timestamp comparisons use TIMESTAMP_ADD() to ensure proper data type handling in BigQuery

This tracking framework provides comprehensive visibility into the entire user lifecycle, enabling data-driven optimization of conversion funnels, retention strategies, and reactivation campaigns.
