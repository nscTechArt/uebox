<template>
  <div class="not-found-page">
    <div class="not-found-container">
      <div class="error-illustration">
        <div class="error-code">404</div>
        <div class="error-icon">
          <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
            <circle
              cx="100"
              cy="100"
              r="80"
              fill="none"
              stroke="var(--color-border)"
              stroke-width="2"
              stroke-dasharray="5,5"
            />
            <path
              d="M70 70 L130 130 M130 70 L70 130"
              stroke="var(--color-text-muted)"
              stroke-width="3"
              stroke-linecap="round"
            />
          </svg>
        </div>
      </div>

      <div class="error-content">
        <h1 class="error-title">{{ $t('systemNotFound.title') }}</h1>
        <p class="error-description">
          {{ $t('systemNotFound.descriptionLine1') }}
          <br />
          {{ $t('systemNotFound.descriptionLine2') }}
        </p>

        <div class="error-actions">
          <AppButton variant="primary" size="large" class="home-button" @click="handleGoHome">
            <PhHouse />
            {{ $t('systemNotFound.homeButton') }}
          </AppButton>

          <AppButton size="large" class="back-button" @click="handleGoBack">
            <PhArrowLeft />
            {{ $t('systemNotFound.backButton') }}
          </AppButton>
        </div>
      </div>
    </div>

    <div class="background-decoration">
      <div class="decoration-circle circle-1"></div>
      <div class="decoration-circle circle-2"></div>
      <div class="decoration-circle circle-3"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { useRouter } from 'vue-router'
import { PhArrowLeft, PhHouse } from '@phosphor-icons/vue'

const router = useRouter()

const handleGoHome = () => {
  router.push('/')
}

const handleGoBack = () => {
  if (window.history.length > 1) {
    router.go(-1)
  } else {
    router.push('/')
  }
}
</script>

<style scoped lang="less">
.not-found-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--color-bg-page) 0%, var(--color-bg-surface) 100%);
  overflow: hidden;

  .not-found-container {
    position: relative;
    z-index: 2;
    text-align: center;
    max-width: 600px;
    padding: 40px 20px;

    .error-illustration {
      margin-bottom: 40px;

      .error-code {
        font-size: 120px;
        font-weight: 700;
        color: var(--color-text-secondary);
        line-height: 1;
        margin-bottom: 20px;
        background: linear-gradient(135deg, var(--color-accent-solid), var(--color-accent-bg));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .error-icon {
        width: 120px;
        height: 120px;
        margin: 0 auto;
        opacity: 0.6;

        svg {
          width: 100%;
          height: 100%;
        }
      }
    }

    .error-content {
      .error-title {
        font-size: 32px;
        font-weight: 600;
        color: var(--color-text-primary);
        margin-bottom: 16px;
        line-height: 1.2;
      }

      .error-description {
        font-size: 16px;
        color: var(--color-text-secondary);
        line-height: 1.6;
        margin-bottom: 40px;
        max-width: 480px;
        margin-left: auto;
        margin-right: auto;
      }

      .error-actions {
        display: flex;
        gap: 16px;
        justify-content: center;
        flex-wrap: wrap;

        .home-button {
          min-width: 140px;
          height: 48px;
          border-radius: var(--radius-md);
          font-weight: 500;
          box-shadow: 0 4px 12px var(--color-accent-border);
          transition: all var(--motion-standard) var(--easing-standard);

          &:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px var(--color-accent-border);
          }
        }

        .back-button {
          min-width: 140px;
          height: 48px;
          border-radius: var(--radius-md);
          font-weight: 500;
          border-color: var(--color-border-subtle);
          color: var(--color-text-primary);
          transition: all var(--motion-standard) var(--easing-standard);

          &:hover {
            transform: translateY(-2px);
            border-color: var(--color-accent-border);
            color: var(--color-accent-text);
            box-shadow: 0 4px 12px var(--shadow-color-weak);
          }
        }
      }
    }
  }

  .background-decoration {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1;
    pointer-events: none;

    .decoration-circle {
      position: absolute;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent-bg), var(--color-accent-bg));
      opacity: 0.1;
      animation: float 6s ease-in-out infinite;

      &.circle-1 {
        width: 200px;
        height: 200px;
        top: 10%;
        left: 10%;
        animation-delay: 0s;
      }

      &.circle-2 {
        width: 150px;
        height: 150px;
        top: 60%;
        right: 15%;
        animation-delay: 2s;
      }

      &.circle-3 {
        width: 100px;
        height: 100px;
        bottom: 20%;
        left: 20%;
        animation-delay: 4s;
      }
    }
  }
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0px) rotate(0deg);
  }
  50% {
    transform: translateY(-20px) rotate(180deg);
  }
}

// 响应式设计
@media (max-width: 768px) {
  .not-found-page {
    .not-found-container {
      padding: 20px;

      .error-illustration {
        .error-code {
          font-size: 80px;
        }

        .error-icon {
          width: 80px;
          height: 80px;
        }
      }

      .error-content {
        .error-title {
          font-size: 24px;
        }

        .error-description {
          font-size: 14px;
        }

        .error-actions {
          flex-direction: column;
          align-items: center;

          .home-button,
          .back-button {
            width: 100%;
            max-width: 280px;
          }
        }
      }
    }
  }
}
</style>
